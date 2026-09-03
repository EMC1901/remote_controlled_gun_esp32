# 机械狗 Linux 蓝牙桥部署

这两个 systemd 文件用于让机械狗服务器通过经典蓝牙 SPP 连接已配置好的 ESP32。网页仍在 Windows 电脑运行；本说明不涉及 ESP32 烧录，也不改变机械狗自身的运动控制服务。

已配置完成的服务器无需重复安装。迁移部署时先物理断开发射电机，确保设备处于安全状态。

## 服务文件中的环境参数

| 项目 | 当前文件值 | 换设备时的处理 |
| --- | --- | --- |
| Linux 用户/组 | `cas` / `cas` | 修改 bridge 服务中的 `User`、`Group` |
| Python 桥目录 | `/home/cas/esp32-gun-controller` | 同步修改 `WorkingDirectory`、`ExecStart` |
| ESP32 蓝牙地址 | `70:4B:CA:6F:42:7A` | 改成现场扫描到的 `ESP32-Gun-SPP` 地址 |
| RFCOMM 通道与设备 | 通道 `1`、`/dev/rfcomm0` | 核对固件的 SPP 通道和设备占用情况 |
| HTTP 端口 | `18765` | 如修改，Windows 隧道目标端口也必须修改 |

服务文件是当前设备的配置样例，不是通用于任意机械狗的一键安装器。不要把已有服务直接覆盖为不匹配的新参数。

## 一次性部署

以下命令适用于使用 systemd 的 Debian/Ubuntu 类系统，需要管理员权限。其他发行版按对应包管理器安装 BlueZ、Python 3 和 pyserial。

### 1. 安装依赖并配对

在服务器上安装依赖：

```bash
sudo apt-get update
sudo apt-get install bluez python3 python3-serial
sudo systemctl enable --now bluetooth.service
```

使用 `bluetoothctl` 开启蓝牙，扫描并核对 `ESP32-Gun-SPP` 的地址；按设备提示完成 `pair` 和 `trust`。不要根据示例地址误配其他设备。结束扫描后退出，持久 SPP 连接由下方 RFCOMM 服务负责。

### 2. 放置桥接程序和服务文件

在服务器创建 `/home/cas/esp32-gun-controller`，并由 `cas` 用户拥有。将仓库内以下文件复制过去：

- `controller_web/bridge/server.py` → `/home/cas/esp32-gun-controller/server.py`
- `controller_web/linux/esp32-gun-rfcomm.service` → `/etc/systemd/system/esp32-gun-rfcomm.service`
- `controller_web/linux/esp32-gun-bridge.service` → `/etc/systemd/system/esp32-gun-bridge.service`

先备份已有同名文件，再根据上表调整参数。systemd 文件由 root 拥有且权限设为 644。桥接服务通过 `SupplementaryGroups=dialout` 获取串口访问权限；确认系统存在该组，且 `/dev/rfcomm0` 的访问权限匹配。确认 `/usr/bin/rfcomm` 和 `/usr/bin/python3` 存在。

### 3. 启动并检查

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now esp32-gun-rfcomm.service
sudo systemctl enable --now esp32-gun-bridge.service
systemctl is-active esp32-gun-rfcomm.service esp32-gun-bridge.service
curl --fail http://127.0.0.1:18765/api/health
curl --fail http://127.0.0.1:18765/api/status
```

两项服务应为 `active`，健康检查应返回 `{"ok":true}`。状态接口返回 `device` 对象，需确认设备报告停止且未发射。这些检查只使用 `PING`/`STATUS`，不发送方向或发射命令。健康检查包含 ESP32 应答，不只是检查 HTTP 端口。

失败时查看日志：

```bash
journalctl -u esp32-gun-rfcomm.service -u esp32-gun-bridge.service -n 80 --no-pager
```

确认服务正常后，回到 [主 README](../../README.md) 配置 Windows 的 SSH 密钥与双击启动。

## 运行与关闭

- RFCOMM 服务退出后自动重试；Python 桥异常退出后也会重启。
- Python 桥固定监听 `127.0.0.1:18765`，不要改成公开监听；仅通过经过认证的 SSH 隧道访问。
- Windows 的“关闭机械狗控制台”不会停用这些服务。
- 如需切回电脑蓝牙直连，应先在网页停止设备、锁定保险并完成现场安全确认，再执行：

```bash
sudo systemctl stop esp32-gun-bridge.service esp32-gun-rfcomm.service
```

这只停止当前服务，不取消开机启动。若还需禁止下次开机自动连接，再对这两项服务执行 `systemctl disable`。服务停止不是物理断电，不能替代现场安全措施。
