# 机械狗与 ESP32：USB 有线模式

连接路径：Windows 网页 → 原 SSH 隧道 → 机械狗的 127.0.0.1:18765 → USB 数据线 → ESP32。电脑端仍使用原来的“启动机械狗控制台.bat”和 http://localhost:3000。

## 固件要求

原蓝牙固件的 USB 串口只输出调试日志，不能通过改串口路径直接实现有线控制。有线版使用 USB 专用固件，115200 波特率、换行分隔命令；状态返回 `transport: usb_serial`，不启动蓝牙控制入口。PWM 范围、速度、上电关闭输出及 300 ms 超时保护保留不变。

固件源文件位于仓库根目录的 [esp32_usb_ch1_ch2_position_control.ino](../../esp32_usb_ch1_ch2_position_control/esp32_usb_ch1_ch2_position_control.ino)。仓库只提供源码，不提供可直接刷写的二进制文件。应使用 ESP32 Arduino Core 3.3.10、`ESP32 Dev Module` 目标编译；刷写前必须核对实际开发板、Flash 布局和串口，不能照搬其他设备的参数。

刷写必须在枪体电池和发射电机物理断开的条件下进行。串口打开、USB 供电变化或刷写都可能让 ESP32 复位并使舵机回到中位。迁移现有设备前应完整备份 Flash，并将备份存放在非仓库目录；完整 Flash 可能包含配对数据或其他设备信息，不得提交到 Git。

## 服务器配置

- 主服务名仍为 `esp32-gun-bridge.service`，原始蓝牙服务文件先备份。
- 将 [esp32-gun-bridge-usb.service](esp32-gun-bridge-usb.service) 安装为 `/etc/systemd/system/esp32-gun-bridge.service`（root 所有、644 权限），完整替换原蓝牙服务定义。它不依赖 RFCOMM，并使用 `--transport usb_serial`；不能用空的 drop-in 依赖项来移除原服务的依赖。
- 串口使用稳定设备标识 `/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0`，避免 ttyUSB 编号变化。换板后需重新核对该路径；序列号相同的多块 CP2102 不能只靠此标识区分。
- 将 [99-esp32-gun-usb.rules](99-esp32-gun-usb.rules) 安装到 `/etc/udev/rules.d/`（root 所有、644 权限），阻止 ModemManager 探测这块板的串口，不停用系统其他调制解调器功能。
- 更新服务器 `/home/cas/esp32-gun-controller/server.py` 为当前版本；需要 Python 3 和 pyserial 3.5。当前机器已有同目录的 pyserial 模块。
- 停止并禁用 `esp32-gun-rfcomm.service`，再加载配置并启动桥接服务。不停用机械狗系统整体的蓝牙服务。

桥接程序在打开 USB 串口前设置 DTR/RTS 为低并请求独占访问，以减少自动复位和串口争用风险；不能保证所有驱动都不会复位。它过滤启动/诊断日志，仅接受匹配的协议应答。USB 动作请求失败后不会自动重发，状态查询和停止类请求允许重连重试。

## 只读检查

```bash
systemctl is-active esp32-gun-bridge.service
systemctl is-enabled esp32-gun-rfcomm.service
curl --fail http://127.0.0.1:18765/api/health
curl --fail http://127.0.0.1:18765/api/status
```

桥接应为 active，RFCOMM 应为 disabled，健康检查返回 `ok: true`，状态中的通信方式为 `usb_serial`。这些 HTTP 请求只发送 PING/STATUS，不产生方向或发射命令。打开串口仍可能产生复位，因此维护期间保持枪体断电。

服务开机启动不等于 ESP32 永远在线；缺线时状态接口返回离线，重新连接后后续查询会重试。拔插电缆必须在现场安全条件下进行。USB 拔掉若导致开发板断电，软件看门狗不能继续工作，不可用它替代枪体物理断电。

## 本次迁移的回退资料（仅本机保存）

服务器目录：`/home/cas/esp32-gun-controller/usb-migration-20260904/`。

- `server-bt.py`：原桥接程序。
- `bridge-bt.service`、`rfcomm-bt.service`：原 systemd 配置。
- `flash-bt-full-4mb.bin`：刷写前的完整 Flash 备份，可能包含配对数据，禁止上传公共仓库。

回退需要先断开枪体电池、停止桥接服务，恢复原 Flash、桥接程序和原服务文件，再重新加载 systemd 并启用原 RFCOMM 服务。不能只改服务器配置而不恢复固件。上述资料不是通用固件，不应刷入其他设备。
