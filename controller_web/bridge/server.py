from __future__ import annotations

import argparse
import json
import signal
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import serial


ALLOWED_COMMANDS = {
    "PING", "STATUS", "LEFT", "RIGHT", "UP", "DOWN", "STOP", "FIRE_ON", "FIRE_OFF"
}
ALLOWED_ORIGINS = {
    "http://127.0.0.1:3000",
    "http://localhost:3000",
}


class SppBridge:
    def __init__(self, port: str, transport: str = "bt_spp") -> None:
        self.port = port
        self.transport = transport
        self._serial: serial.Serial | None = None
        self._lock = threading.Lock()

    def _connect(self) -> serial.Serial:
        if self._serial is not None and self._serial.is_open:
            return self._serial

        connection = serial.Serial(
            port=None,
            baudrate=115200,
            timeout=2.0,
            write_timeout=2.0,
        )
        if self.transport == "usb_serial":
            # Set control lines before opening to reduce ESP32 auto-reset risk.
            # Some drivers still pulse these lines on open; power the load off
            # during maintenance and do not rely on this as a safety interlock.
            connection.dtr = False
            connection.rts = False
            connection.exclusive = True
        connection.port = self.port
        connection.open()
        self._serial = connection
        time.sleep(1.2)
        self._serial.reset_input_buffer()
        return self._serial

    def close(self) -> None:
        with self._lock:
            if self._serial is None:
                return
            try:
                if self._serial.is_open:
                    self._serial.write(b"STOP\n")
                    self._serial.flush()
            except serial.SerialException:
                pass
            finally:
                self._serial.close()
                self._serial = None

    def transact(self, command: str) -> list[str]:
        command = command.strip().upper()
        if command not in ALLOWED_COMMANDS:
            raise ValueError("命令不在安全白名单中")

        # USB boot/diagnostic lines must not be mistaken for protocol replies.
        expected_lines = 1

        with self._lock:
            for attempt in range(2):
                try:
                    spp = self._connect()
                    spp.reset_input_buffer()
                    spp.write(f"{command}\n".encode("ascii"))
                    spp.flush()

                    responses: list[str] = []
                    deadline = time.monotonic() + 3.0
                    while len(responses) < expected_lines and time.monotonic() < deadline:
                        line = spp.readline().decode("utf-8", errors="replace").strip()
                        if line and self._matches_response(command, line):
                            responses.append(line)

                    if len(responses) != expected_lines:
                        raise TimeoutError("ESP32回执超时")
                    return responses
                except (serial.SerialException, OSError, TimeoutError):
                    if self._serial is not None:
                        try:
                            self._serial.close()
                        except serial.SerialException:
                            pass
                        self._serial = None
                    if attempt == 1 or (
                        self.transport == "usb_serial"
                        and command not in {"PING", "STATUS", "STOP", "FIRE_OFF"}
                    ):
                        raise
                    time.sleep(0.6)

        raise RuntimeError("设备通信事务未完成")

    @staticmethod
    def _matches_response(command: str, line: str) -> bool:
        if line.startswith("ERR "):
            raise ValueError(f"ESP32拒绝命令：{line}")
        if command == "PING":
            return line == "PONG"
        if command == "STATUS":
            try:
                payload = json.loads(line)
            except ValueError:
                return False
            return isinstance(payload, dict) and "control_mode" in payload
        if command == "STOP":
            return line.startswith("ACK HOLD ")
        if command in {"FIRE_ON", "FIRE_OFF"}:
            return line.startswith(f"ACK {command} ")
        return line.startswith(f"ACK {command}_ACTIVE ") or line.startswith(
            f"LIMIT {command} "
        )


class ControlHandler(BaseHTTPRequestHandler):
    bridge: SppBridge

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[web] {self.address_string()} {format % args}")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "来源被拒绝"})
            return
        self.send_response(HTTPStatus.NO_CONTENT.value)
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "来源被拒绝"})
            return
        try:
            if self.path == "/api/health":
                responses = self.bridge.transact("PING")
                self._send_json(HTTPStatus.OK, {"ok": responses == ["PONG"]})
                return
            if self.path == "/api/status":
                responses = self.bridge.transact("STATUS")
                device = json.loads(responses[0])
                self._send_json(HTTPStatus.OK, {"ok": True, "device": device})
                return
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
        except Exception as error:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "error": f"设备连接失败：{error}"},
            )

    def do_POST(self) -> None:
        if not self._origin_allowed():
            self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "来源被拒绝"})
            return
        if self.path != "/api/command":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > 256:
                raise ValueError("请求大小无效")
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            command = str(payload.get("command", "")).upper()
            if command not in {"LEFT", "RIGHT", "UP", "DOWN", "STOP", "FIRE_ON", "FIRE_OFF"}:
                raise ValueError("网页命令不在当前安全白名单中")
            responses = self.bridge.transact(command)
            self._send_json(
                HTTPStatus.OK,
                {"ok": True, "command": command, "responses": responses},
            )
        except ValueError as error:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        except Exception as error:
            self._send_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"ok": False, "error": f"命令未执行：{error}"},
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="ESP32 Bluetooth/USB serial web bridge")
    parser.add_argument("--port", default="COM4", help="Bluetooth COM/RFCOMM or USB serial device")
    parser.add_argument("--transport", choices=("bt_spp", "usb_serial"), default="bt_spp")
    parser.add_argument("--listen", type=int, default=8765, help="Loopback HTTP port")
    args = parser.parse_args()

    bridge = SppBridge(args.port, args.transport)
    ControlHandler.bridge = bridge
    server = ThreadingHTTPServer(("127.0.0.1", args.listen), ControlHandler)

    def stop_server(_signum: int, _frame: Any) -> None:
        bridge.close()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    signal.signal(signal.SIGTERM, stop_server)

    print(f"Local {args.transport} bridge: http://127.0.0.1:{args.listen} -> {args.port}")
    try:
        server.serve_forever()
    finally:
        bridge.close()
        server.server_close()


if __name__ == "__main__":
    main()
