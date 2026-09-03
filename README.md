# ESP32 玩具遥控枪网页控制台

通过 Windows 电脑上的网页控制已配置好的 ESP32 玩具设备，支持两种连接方式：电脑直接通过经典蓝牙 SPP 连接 ESP32，或通过 SSH 隧道让机械狗服务器承担蓝牙连接。

网页始终运行在电脑的 [http://localhost:3000](http://localhost:3000)。机械狗模式不需要电脑连接 ESP32 蓝牙，也不需要在机械狗服务器上运行 Node.js。

本仓库包含网页、Python 蓝牙桥、Windows 启停脚本及 Linux systemd 服务文件，**不包含 ESP32 固件、硬件接线资料、SSH 私钥或密码**。使用前，ESP32 必须已经配置兼容协议并广播 `ESP32-Gun-SPP`；下载本仓库不会自动烧录或配置 ESP32。

## 日常使用

首次配置完成后，只需双击对应文件：

| 连接方式 | 启动 | 关闭 |
| --- | --- | --- |
| 通过机械狗服务器 | [启动机械狗控制台.bat](controller_web/启动机械狗控制台.bat) | [关闭机械狗控制台.bat](controller_web/关闭机械狗控制台.bat) |
| 电脑直接连接 ESP32 蓝牙 | [启动控制台.bat](controller_web/启动控制台.bat) | [关闭控制台.bat](controller_web/关闭控制台.bat) |

启动后浏览器自动打开，页面显示“蓝牙在线”才表示设备可通信。关闭脚本会尝试先发送 `STOP`，再关闭对应的本机后台进程。**仅关闭浏览器标签页不会退出后台服务。**

两种模式都使用本机端口 3000 和 8765，不要同时运行。切换前先使用原模式的关闭脚本；机械狗启动脚本也会清理本项目的直连模式进程。

## 功能与安全边界

- 按住方向按钮移动，松开后保持当前位置；CH1/CH2 为 1000–2000 μs、300 μs/s。
- 发射需要先确认安全条件并手动解除网页保险，再按住按钮；松开停止。
- 方向与发射互斥。网页保险解除时，方向按钮禁用；恢复移动前需手动锁定保险。
- 全部停止、空格或 Esc 会停止两轴目标变化并关闭发射输出，不会自动重新锁定网页保险。
- 兼容固件应实现独立的 300 ms 方向与发射心跳看门狗。网页失焦或链路断开时，方向保持最后位置、发射关闭；这依赖固件保护，不是 SSH 提供的保证。
- 网页保险属于界面状态，不是服务端身份验证。只能在可信电脑和受控网络中使用，不要公开控制接口。
- 网页监听本机 localhost；Python 桥固定监听回环地址，SSH 转发也只绑定 `127.0.0.1`。

## 两种连接路径

```text
Windows 浏览器：http://localhost:3000
               │
               ▼
       http://127.0.0.1:8765
               │
       ┌───────┴────────┐
       │                │
  电脑蓝牙直连       机械狗 SSH 模式
  本机 Python 桥     SSH 本地端口转发
       │                │
  Windows COM 口    服务器 127.0.0.1:18765
       │            Python 桥 → /dev/rfcomm0
       │                │
       └───────┬────────┘
               ▼
       经典蓝牙 ESP32-Gun-SPP
```

## 公共准备：下载与安装网页依赖

需要 Windows 10/11、PowerShell，以及 [Node.js](https://nodejs.org/) 22.13 或更高版本。建议将项目放在不含空格的路径，例如 `C:\projects\remote_controlled_gun_esp32`。

```powershell
git clone https://github.com/EMC1901/remote_controlled_gun_esp32.git
cd remote_controlled_gun_esp32\controller_web
npm ci
```

也可以在 GitHub 点击 **Code → Download ZIP**，解压后在 `controller_web` 目录执行 `npm ci`。日常双击启动不再需要执行安装命令。

## 方式 A：通过机械狗服务器（SSH 隧道）

### 1. 确认服务器准备完成

- 电脑能访问机械狗的 SSH 服务，当前脚本目标为 `cas@10.42.0.1`。
- 机械狗具备经典蓝牙能力，并已配对、信任 `ESP32-Gun-SPP`。
- 服务器已部署本项目 Python 桥，且 `esp32-gun-rfcomm.service` 和 `esp32-gun-bridge.service` 正常运行。
- 服务器上的桥接地址为 `127.0.0.1:18765`。首次部署见 [Linux 服务部署说明](controller_web/linux/README.md)。

这一模式只要求 Windows 安装 OpenSSH 客户端和 Node.js；电脑不需要 Python 或蓝牙串口。

### 2. 一次性配置 SSH 密钥

**原电脑已配置好的密钥可以继续使用；新电脑必须自行配置，GitHub 下载包不包含密钥。**

1. 在 PowerShell 运行 `ssh cas@10.42.0.1`，先与服务器管理员核对主机指纹，再接受并完成一次登录。这会建立本机 `known_hosts` 记录。随后输入 `exit` 退出。
2. 使用 `ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\esp32_gun_cas_m8s_v2"` 创建专用密钥。若文件已存在，不要覆盖。
3. 仅把生成的 `.pub` 公钥追加到服务器用户 `cas` 的 `~/.ssh/authorized_keys`；服务器上的 `.ssh` 目录权限应为 700，`authorized_keys` 为 600，归该用户所有。私钥始终保留在电脑上。
4. 若私钥设置了口令，应先通过 Windows `ssh-agent` 解锁并加载。脚本使用非交互登录，不会弹出密码或密钥口令提示。无口令私钥虽方便，但必须限制本机文件访问并妥善保管。

在 PowerShell 验证非交互登录：

```powershell
ssh -i "$env:USERPROFILE\.ssh\esp32_gun_cas_m8s_v2" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes cas@10.42.0.1 "echo SSH_OK"
```

返回 `SSH_OK` 后即可双击启动。不要为了绕过主机密钥错误而关闭主机指纹校验。

### 3. 双击启动

双击 `controller_web\启动机械狗控制台.bat`，脚本将建立以下隧道，等待设备健康检查通过，再启动并打开网页：

```text
电脑 127.0.0.1:8765 → SSH cas@10.42.0.1 → 服务器 127.0.0.1:18765
```

后台守护脚本在 SSH 进程退出后等待 2 秒重试；这不代表网络故障一定在 2 秒内恢复。重复启动时，若已有进程和接口正常，只重新打开网页。

如需更换服务器或密钥：修改 [dog_tunnel_watchdog.ps1](controller_web/dog_tunnel_watchdog.ps1) 中的 SSH 目标及 `$sshKey`，同时修改 [start_dog_controller.ps1](controller_web/start_dog_controller.ps1) 中的 `$sshKey`。仅修改 `controller.config.json` 不会影响机械狗模式。

关闭机械狗控制台只关闭电脑端网页和 SSH 隧道，**不会停用服务器上的 systemd 服务或关闭设备电源**。

## 方式 B：Windows 直接连接 ESP32 蓝牙

1. 安装 Python 3，并启用 Python Launcher，确认 `py -3 --version` 可运行。
2. 给 ESP32 独立供电，在 Windows 蓝牙设置中配对 `ESP32-Gun-SPP`。
3. 在设备管理器中找到设备的**传出**蓝牙串口，例如 `COM6`，将 [controller.config.json](controller_web/controller.config.json) 的 `bluetooth_port` 改成实际串口。
4. 双击 `controller_web\启动控制台.bat`。首次启动会建立 Python 虚拟环境并安装 `pyserial`，需要能下载依赖。
5. 使用结束后双击 `controller_web\关闭控制台.bat`，释放蓝牙串口。

同一 ESP32 不应同时被 Windows 直连程序和机械狗的 RFCOMM 服务占用。切回 Windows 直连前，需要先停用机械狗侧的蓝牙连接服务。

## 排查问题

| 现象 | 检查内容 |
| --- | --- |
| `SSH key is missing` | 当前用户的 `.ssh` 目录是否有脚本指定的私钥；新电脑需重新配置 |
| `Permission denied (publickey...)` | 公钥、服务器用户和文件权限是否正确；带口令的密钥是否已加入 agent |
| `Host key verification failed` | 手动 SSH 登录并核对服务器指纹；主机密钥变化时先确认原因 |
| 机械狗桥未就绪 | 网络、SSH 登录、两项 Linux 服务，以及 ESP32 供电和蓝牙连接 |
| 网页可打开但蓝牙离线 | 直连模式检查传出 COM 口；机械狗模式检查 RFCOMM 和服务器服务日志 |
| 页面打不开或端口冲突 | 先关闭另一种控制模式，确认端口 3000/8765 没被其他程序占用，再重新启动 |
| `127.0.0.1:3000` 无法打开 | 使用脚本指定的 `http://localhost:3000`；本机前端可能监听 IPv6 回环 `::1` |
| 缺少网页依赖 | 在 `controller_web` 目录运行 `npm ci` |

本机日志位于 `controller_web\logs\`：机械狗模式使用 `dog-tunnel.error.log`、`dog-frontend.error.log` 和对应的 `.out.log`；直连模式使用 `backend.error.log`、`frontend.error.log` 和对应的 `.out.log`。PID 文件、依赖、日志和凭据不应提交到 Git。

## 首次使用与操作结束

1. 先给 ESP32 上电，再给玩具设备上电；关闭时顺序相反。ESP32 重启可能使舵机回到中位。
2. 首次部署及迁移后先物理断开发射电机，在安全、无负载条件下确认方向、机械限位及停止保护。
3. 确认松键、页面失焦和连接中断后输出能关闭；软件状态不能替代现场确认。
4. 操作结束先停止并手动锁定网页保险，再运行关闭脚本，最后按现场流程断电。

> 仅用于玩具设备。请始终保持现场监护，不对准人员、动物或易损物品；SSH 自动重连不能代替物理断电措施。不要把本项目控制接口发布到公网。
