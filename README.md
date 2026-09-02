# ESP32 玩具遥控枪电脑控制台

这是一个运行在 Windows 电脑上的本地控制程序。电脑通过经典蓝牙 SPP 与已配置好的 ESP32 通信，再由 ESP32 控制玩具遥控枪的水平、俯仰和发射通道。

本仓库只包含电脑端程序。ESP32 应已预先配置并能广播蓝牙设备 `ESP32-Gun-SPP`，使用者不需要安装 Arduino IDE，也不需要烧录或修改 ESP32。

## 功能

- 浏览器按钮控制上、下、左、右，松开后保持当前位置
- CH1、CH2 使用 1000–2000 μs 范围和 300 μs/s 渐变速度
- 发射保险由使用者手动锁定或解除
- 按住发射、松开停止；发射心跳超时或蓝牙断开时自动关闭输出
- 双击启动和关闭，无需每次使用命令行
- 网页与蓝牙桥只监听本机地址，不向局域网或互联网开放

## 使用条件

- Windows 10 或 Windows 11，电脑支持经典蓝牙 SPP
- 已配置本项目协议的 ESP32，蓝牙名称为 `ESP32-Gun-SPP`
- [Node.js](https://nodejs.org/) 22.13 或更高版本
- [Python](https://www.python.org/downloads/) 3，并在安装时启用 Python Launcher（命令 `py`）

## 下载与部署

### 1. 下载项目

可以在 GitHub 页面选择 **Code → Download ZIP** 并解压，也可以使用 Git：

```powershell
git clone https://github.com/EMC1901/remote_controlled_gun_esp32.git
cd remote_controlled_gun_esp32\controller_web
```

### 2. 安装网页依赖

在 `controller_web` 文件夹中打开 PowerShell，执行一次：

```powershell
npm install
```

Python 虚拟环境及蓝牙串口依赖会在第一次启动控制台时自动建立和安装。

### 3. 配对 ESP32

1. 给 ESP32 使用独立 5V 电源供电。
2. 在 Windows 的蓝牙设置中配对 `ESP32-Gun-SPP`。
3. 打开“设备管理器 → 端口（COM 和 LPT）”，找到该设备的**传出**蓝牙串口，例如 `COM6`。

### 4. 设置蓝牙串口

用记事本打开 [`controller_web/controller.config.json`](controller_web/controller.config.json)，把端口改为实际值：

```json
{
  "bluetooth_port": "COM6"
}
```

### 5. 启动和关闭

- 双击 `controller_web\启动控制台.bat`，程序会启动本机服务并自动打开 `http://localhost:3000`。
- 页面显示“蓝牙在线”后即可使用。
- 使用完毕后双击 `controller_web\关闭控制台.bat`，程序会先发送停止命令，再关闭相关服务。

## 首次使用建议

1. 先给 ESP32 上电，再给玩具枪上电；关闭时顺序相反。
2. 首次部署先断开发射电机，在无负载状态下确认上下左右和 CH3 输出正常。
3. 确认页面失焦、蓝牙断开及松开发射按钮后，CH3 都会恢复到 1000 μs。
4. 重新接入发射机构前，确保枪口朝向安全区域并清空无关人员。

## 常见问题

### 页面显示蓝牙离线

- 确认 ESP32 已独立供电并完成蓝牙配对。
- 确认 `controller.config.json` 填写的是传出串口，而不是传入串口。
- 确认该 COM 端口没有被其他串口工具占用。
- 双击“关闭控制台”后重新启动。

### 提示缺少网页依赖

进入 `controller_web` 文件夹重新执行：

```powershell
npm install
```

### 无法创建 Python 环境

重新安装 Python 3，并确认以下命令可以运行：

```powershell
py -3 --version
```

## 工作方式

```text
浏览器 http://localhost:3000
          ↓ 本机 HTTP
Python 蓝牙桥 127.0.0.1:8765
          ↓ Windows 经典蓝牙 SPP 串口
ESP32-Gun-SPP
          ↓ 50 Hz PWM
CH1 水平 / CH2 俯仰 / CH3 发射
```

> 本项目用于玩具设备。使用者应自行确认当地规定、现场环境及机械限位，并始终避免将发射方向对准人员、动物或易损物品。
