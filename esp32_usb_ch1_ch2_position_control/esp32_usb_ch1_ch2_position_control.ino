#include <Arduino.h>
// USB-UART transport only; motor limits and watchdogs match the Bluetooth firmware.

constexpr uint32_t kPwmFrequencyHz = 50;
constexpr uint8_t kPwmResolutionBits = 16;
constexpr uint32_t kPwmPeriodUs = 1000000UL / kPwmFrequencyHz;
constexpr uint32_t kMaximumDuty = (1UL << kPwmResolutionBits) - 1UL;
constexpr uint16_t kCenterUs = 1500;
constexpr uint32_t kCommandWatchdogMs = 300;
constexpr uint8_t kFirePin = 21;
constexpr uint16_t kFireOffUs = 1000;
constexpr uint16_t kFireOnUs = 2000;
constexpr uint32_t kFireWatchdogMs = 300;
constexpr uint32_t kRampIntervalMs = 20;
constexpr uint16_t kRampStepUs = 6;
constexpr uint16_t kRampUsPerSecond =
    (1000 / kRampIntervalMs) * kRampStepUs;

enum class Motion : int8_t {
  kStopped = 0,
  kTowardLowerPulse = -1,
  kTowardHigherPulse = 1,
};

struct AxisState {
  const char* name;
  uint8_t pin;
  uint16_t pulseUs;
  uint16_t lowerLimitUs;
  uint16_t higherLimitUs;
  Motion motion;
  uint32_t lastDirectionCommandMs;
  uint32_t lastRampUpdateMs;
  bool pwmReady;
};

AxisState ch1{"CH1", 18, kCenterUs, 1000, 2000, Motion::kStopped, 0, 0,
              false};
AxisState ch2{"CH2", 19, kCenterUs, 1000, 2000, Motion::kStopped, 0, 0,
              false};

String commandBuffer;
bool discardCommandUntilNewline = false;
bool firePwmReady = false;
bool fireActive = false;
uint16_t firePulseUs = kFireOffUs;
uint32_t lastFireCommandMs = 0;

uint32_t microsecondsToDuty(uint32_t pulseWidthUs) {
  return (pulseWidthUs * kMaximumDuty + (kPwmPeriodUs / 2)) / kPwmPeriodUs;
}

const char* motionName(const AxisState& axis) {
  if (axis.motion == Motion::kTowardLowerPulse) return "lower";
  if (axis.motion == Motion::kTowardHigherPulse) return "higher";
  return "stopped";
}

void setAxisPulse(AxisState& axis, uint16_t pulseUs) {
  axis.pulseUs = constrain(pulseUs, axis.lowerLimitUs, axis.higherLimitUs);
  if (axis.pwmReady) {
    ledcWrite(axis.pin, microsecondsToDuty(axis.pulseUs));
  }
}

void setFirePulse(uint16_t pulseUs) {
  firePulseUs = constrain(pulseUs, kFireOffUs, kFireOnUs);
  if (firePwmReady) {
    ledcWrite(kFirePin, microsecondsToDuty(firePulseUs));
  }
}

void forceFireOff(const char* reason) {
  const bool wasActive = fireActive || firePulseUs != kFireOffUs;
  fireActive = false;
  setFirePulse(kFireOffUs);
  if (wasActive) {
    Serial.printf("# FIRE_OFF reason=%s us=%u\n", reason, firePulseUs);
  }
}

void sendReply(const String& line) {
  Serial.println(line);
}

void stopAndHold(AxisState& axis, const char* reason) {
  axis.motion = Motion::kStopped;
  setAxisPulse(axis, axis.pulseUs);
  Serial.printf("# %s_HOLD reason=%s us=%u\n", axis.name, reason,
                axis.pulseUs);
}

void stopAndHoldBoth(const char* reason) {
  stopAndHold(ch1, reason);
  stopAndHold(ch2, reason);
}

void startOrKeepMotion(AxisState& axis, Motion requestedMotion,
                       const char* directionName) {
  axis.lastDirectionCommandMs = millis();
  const bool atLower = requestedMotion == Motion::kTowardLowerPulse &&
                       axis.pulseUs <= axis.lowerLimitUs;
  const bool atHigher = requestedMotion == Motion::kTowardHigherPulse &&
                        axis.pulseUs >= axis.higherLimitUs;
  if (atLower || atHigher) {
    stopAndHold(axis, "SOFT_LIMIT");
    sendReply(String("LIMIT ") + directionName + " axis=" +
                      axis.name + " us=" + axis.pulseUs + " range_us=" +
                      axis.lowerLimitUs + "-" + axis.higherLimitUs);
    return;
  }

  axis.motion = requestedMotion;
  sendReply(String("ACK ") + directionName + "_ACTIVE axis=" +
                    axis.name + " us=" + axis.pulseUs + " range_us=" +
                    axis.lowerLimitUs + "-" + axis.higherLimitUs);
}

void updateAxisRamp(AxisState& axis) {
  const uint32_t now = millis();
  while (axis.motion != Motion::kStopped &&
         now - axis.lastRampUpdateMs >= kRampIntervalMs) {
    axis.lastRampUpdateMs += kRampIntervalMs;
    if (axis.motion == Motion::kTowardLowerPulse) {
      if (axis.pulseUs <= axis.lowerLimitUs + kRampStepUs) {
        setAxisPulse(axis, axis.lowerLimitUs);
        stopAndHold(axis, "LOWER_SOFT_LIMIT_REACHED");
      } else {
        setAxisPulse(axis, axis.pulseUs - kRampStepUs);
      }
    } else if (axis.motion == Motion::kTowardHigherPulse) {
      if (axis.pulseUs + kRampStepUs >= axis.higherLimitUs) {
        setAxisPulse(axis, axis.higherLimitUs);
        stopAndHold(axis, "HIGHER_SOFT_LIMIT_REACHED");
      } else {
        setAxisPulse(axis, axis.pulseUs + kRampStepUs);
      }
    }
  }
  if (axis.motion == Motion::kStopped) axis.lastRampUpdateMs = now;
}

void applyAxisWatchdog(AxisState& axis, uint32_t now) {
  if (axis.motion != Motion::kStopped &&
      now - axis.lastDirectionCommandMs > kCommandWatchdogMs) {
    stopAndHold(axis, "COMMAND_WATCHDOG");
  }
}

void processCommand(String command) {
  command.trim();
  command.toUpperCase();
  if (command.isEmpty()) return;

  if (command == "PING") {
    sendReply("PONG");
  } else if (command == "STATUS") {
    sendReply(
        String("{\"status\":\"") +
        (ch1.pwmReady && ch2.pwmReady && firePwmReady ? "ok" :
                                                            "pwm_failed") +
        "\",\"transport\":\"usb_serial\",\"control_mode\":\"full_control\"," +
        "\"ch1_us\":" + ch1.pulseUs + ",\"ch2_us\":" + ch2.pulseUs +
        ",\"fire_us\":" + firePulseUs +
        ",\"fire_active\":" + (fireActive ? "true" : "false") +
        ",\"ch1_motion\":\"" + motionName(ch1) +
        "\",\"ch2_motion\":\"" + motionName(ch2) +
        "\",\"center_us\":" + kCenterUs +
        ",\"ch1_right_limit_us\":" + ch1.lowerLimitUs +
        ",\"ch1_left_limit_us\":" + ch1.higherLimitUs +
        ",\"ch2_up_limit_us\":" + ch2.higherLimitUs +
        ",\"ch2_down_limit_us\":" + ch2.lowerLimitUs +
        ",\"ramp_us_per_second\":" + kRampUsPerSecond +
        ",\"watchdog_ms\":" + kCommandWatchdogMs +
        ",\"fire_watchdog_ms\":" + kFireWatchdogMs +
        ",\"holding_position\":true,\"ch2_attached\":true," +
        "\"fire_attached\":true}");
  } else if (command == "RIGHT") {
    forceFireOff("AXIS_COMMAND");
    startOrKeepMotion(ch1, Motion::kTowardLowerPulse, "RIGHT");
  } else if (command == "LEFT") {
    forceFireOff("AXIS_COMMAND");
    startOrKeepMotion(ch1, Motion::kTowardHigherPulse, "LEFT");
  } else if (command == "UP") {
    forceFireOff("AXIS_COMMAND");
    startOrKeepMotion(ch2, Motion::kTowardHigherPulse, "UP");
  } else if (command == "DOWN") {
    forceFireOff("AXIS_COMMAND");
    startOrKeepMotion(ch2, Motion::kTowardLowerPulse, "DOWN");
  } else if (command == "FIRE_ON") {
    if (!fireActive) stopAndHoldBoth("FIRE_COMMAND");
    fireActive = true;
    lastFireCommandMs = millis();
    setFirePulse(kFireOnUs);
    sendReply(String("ACK FIRE_ON axis=FIRE us=") + firePulseUs +
                      " watchdog_ms=" + kFireWatchdogMs);
  } else if (command == "FIRE_OFF") {
    forceFireOff("FIRE_OFF_COMMAND");
    sendReply(String("ACK FIRE_OFF axis=FIRE us=") + firePulseUs);
  } else if (command == "STOP") {
    stopAndHoldBoth("STOP_COMMAND");
    forceFireOff("STOP_COMMAND");
    sendReply(String("ACK HOLD CH1=") + ch1.pulseUs +
                      " CH2=" + ch2.pulseUs + " FIRE=" + firePulseUs);
  } else {
    sendReply("ERR UNKNOWN_COMMAND");
  }
}

void setup() {
  pinMode(ch1.pin, OUTPUT);
  pinMode(ch2.pin, OUTPUT);
  pinMode(kFirePin, OUTPUT);
  digitalWrite(ch1.pin, LOW);
  digitalWrite(ch2.pin, LOW);
  digitalWrite(kFirePin, LOW);
  ch1.pwmReady = ledcAttach(ch1.pin, kPwmFrequencyHz, kPwmResolutionBits);
  ch2.pwmReady = ledcAttach(ch2.pin, kPwmFrequencyHz, kPwmResolutionBits);
  firePwmReady = ledcAttach(kFirePin, kPwmFrequencyHz, kPwmResolutionBits);
  setAxisPulse(ch1, kCenterUs);
  setAxisPulse(ch2, kCenterUs);
  setFirePulse(kFireOffUs);

  Serial.begin(115200);
  delay(500);
  const uint32_t now = millis();
  ch1.lastRampUpdateMs = now;
  ch2.lastRampUpdateMs = now;
  Serial.println(ch1.pwmReady && ch2.pwmReady && firePwmReady ?
                     "USB_FULL_CONTROL_READY" :
                     "PWM_ATTACH_FAILED");
  Serial.println(
      "CH1_D18=1000-2000us CH2_D19=1000-2000us FIRE_D21=1000us_OFF");
  Serial.printf("# RAMP=%uus_per_second AXIS_WATCHDOG=%lums ACTION=HOLD_LAST_POSITION\n",
                kRampUsPerSecond,
                static_cast<unsigned long>(kCommandWatchdogMs));
  Serial.println("CH2_DIRECTION=HIGHER_IS_UP LOWER_IS_DOWN");
  Serial.printf("# FIRE_CONTROL=HOLD_2000_RELEASE_1000 FIRE_WATCHDOG=%lums\n",
                static_cast<unsigned long>(kFireWatchdogMs));

  Serial.println("USB_SERIAL_READY BAUD=115200 BLUETOOTH=DISABLED");
}

void loop() {
  while (Serial.available()) {
    const char incoming = static_cast<char>(Serial.read());
    if (incoming == '\r') continue;
    if (incoming == '\n') {
      if (discardCommandUntilNewline) {
        discardCommandUntilNewline = false;
        sendReply("ERR COMMAND_TOO_LONG");
      } else {
        processCommand(commandBuffer);
      }
      commandBuffer = "";
    } else if (!discardCommandUntilNewline) {
      if (commandBuffer.length() < 64) {
        commandBuffer += incoming;
      } else {
        commandBuffer = "";
        discardCommandUntilNewline = true;
      }
    }
  }

  const uint32_t now = millis();
  applyAxisWatchdog(ch1, now);
  applyAxisWatchdog(ch2, now);
  if (fireActive && now - lastFireCommandMs > kFireWatchdogMs) {
    forceFireOff("FIRE_WATCHDOG");
  }
  updateAxisRamp(ch1);
  updateAxisRamp(ch2);
  delay(2);
}
