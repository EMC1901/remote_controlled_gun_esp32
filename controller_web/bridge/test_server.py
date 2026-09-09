import unittest
from unittest.mock import MagicMock, patch

import serial

from server import SppBridge


class BridgeTests(unittest.TestCase):
    def test_protocol_matching_rejects_diagnostics_and_stale_acks(self):
        self.assertFalse(SppBridge._matches_response("PING", "USB_SERIAL_READY"))
        self.assertFalse(SppBridge._matches_response("PING", "ACK HOLD CH1=1500"))
        self.assertTrue(SppBridge._matches_response("PING", "PONG"))
        self.assertFalse(SppBridge._matches_response("STATUS", "# CH1_HOLD"))
        self.assertFalse(SppBridge._matches_response("STATUS", "[]"))
        self.assertTrue(SppBridge._matches_response(
            "STATUS", '{"control_mode":"full_control","transport":"usb_serial"}'
        ))
        self.assertTrue(SppBridge._matches_response("STOP", "ACK HOLD CH1=1500"))
        self.assertTrue(SppBridge._matches_response("LEFT", "LIMIT LEFT axis=CH1"))
        self.assertFalse(SppBridge._matches_response("LEFT", "ACK RIGHT_ACTIVE axis=CH1"))
        with self.assertRaises(ValueError):
            SppBridge._matches_response("PING", "ERR UNKNOWN_COMMAND")

    @patch("server.time.sleep")
    @patch("server.serial.Serial")
    def test_usb_sets_control_lines_before_open(self, serial_factory, _sleep):
        port = serial_factory.return_value

        def check_open():
            self.assertIs(port.dtr, False)
            self.assertIs(port.rts, False)
            self.assertIs(port.exclusive, True)
            self.assertEqual(port.port, "/dev/test-esp32")

        port.open.side_effect = check_open
        bridge = SppBridge("/dev/test-esp32", "usb_serial")
        self.assertIs(bridge._connect(), port)
        serial_factory.assert_called_once_with(
            port=None, baudrate=115200, timeout=2.0, write_timeout=2.0
        )
        port.open.assert_called_once()

    @patch("server.time.sleep")
    def test_usb_skips_boot_and_diagnostic_lines(self, _sleep):
        port = MagicMock()
        port.readline.side_effect = [
            b"rst:0x1 boot:0x13\n", b"# CH1_HOLD\n", b"PONG\n"
        ]
        bridge = SppBridge("/dev/test-esp32", "usb_serial")
        with patch.object(bridge, "_connect", return_value=port):
            self.assertEqual(bridge.transact("PING"), ["PONG"])
        port.write.assert_called_once_with(b"PING\n")

    @patch("server.time.sleep")
    def test_usb_does_not_replay_action_on_serial_failure(self, _sleep):
        for command in ("LEFT", "RIGHT", "UP", "DOWN", "FIRE_ON"):
            with self.subTest(command=command):
                port = MagicMock()
                port.readline.side_effect = serial.SerialException("unplugged")
                bridge = SppBridge("/dev/test-esp32", "usb_serial")
                bridge._serial = port
                with patch.object(bridge, "_connect", return_value=port):
                    with self.assertRaises(serial.SerialException):
                        bridge.transact(command)
                port.write.assert_called_once()
                port.close.assert_called_once()
                self.assertIsNone(bridge._serial)

    @patch("server.time.sleep")
    def test_read_only_request_can_reconnect(self, _sleep):
        broken, healthy = MagicMock(), MagicMock()
        broken.readline.side_effect = serial.SerialException("unplugged")
        healthy.readline.return_value = b"PONG\n"
        bridge = SppBridge("/dev/test-esp32", "usb_serial")
        bridge._serial = broken
        with patch.object(bridge, "_connect", side_effect=[broken, healthy]):
            self.assertEqual(bridge.transact("PING"), ["PONG"])
        broken.close.assert_called_once()
        healthy.write.assert_called_once_with(b"PING\n")

    def test_close_requests_stop_and_releases_port(self):
        port = MagicMock()
        bridge = SppBridge("/dev/test-esp32", "usb_serial")
        bridge._serial = port
        bridge.close()
        port.write.assert_called_once_with(b"STOP\n")
        port.close.assert_called_once()
        self.assertIsNone(bridge._serial)

    def test_legacy_default_and_command_whitelist(self):
        bridge = SppBridge("COM4")
        self.assertEqual(bridge.transport, "bt_spp")
        with self.assertRaises(ValueError):
            bridge.transact("UNRECOGNIZED")


if __name__ == "__main__":
    unittest.main()
