'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bluetooth,
  Cable,
  CircleStop,
  Crosshair,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const API_BASE = 'http://127.0.0.1:8765';
const KEEPALIVE_DELAY_MS = 80;

type DeviceStatus = {
  status: string;
  transport: string;
  control_mode: 'full_control';
  ch1_us: number;
  ch2_us: number;
  ch1_motion: 'lower' | 'higher' | 'stopped';
  ch2_motion: 'lower' | 'higher' | 'stopped';
  center_us: number;
  ch1_right_limit_us: number;
  ch1_left_limit_us: number;
  ch2_up_limit_us: number;
  ch2_down_limit_us: number;
  ramp_us_per_second: number;
  watchdog_ms: number;
  holding_position: boolean;
  ch2_attached: boolean;
  fire_attached: boolean;
  fire_us: number;
  fire_active: boolean;
  fire_watchdog_ms: number;
};

type Direction = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
type CommandName = Direction | 'STOP' | 'FIRE_ON' | 'FIRE_OFF';

export default function Home() {
  const [online, setOnline] = useState(false);
  const [checking, setChecking] = useState(false);
  const [armed, setArmed] = useState(false);
  const [fireHolding, setFireHolding] = useState(false);
  const [safetyDialogOpen, setSafetyDialogOpen] = useState(false);
  const [holding, setHolding] = useState<Direction | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [message, setMessage] = useState('正在检查设备连接…');
  const isUsb = status?.transport === 'usb_serial';
  const transportLabel = status ? (isUsb ? 'USB 串口' : '经典蓝牙 SPP') : '等待设备连接';
  const [lastCommand, setLastCommand] = useState('尚未发送控制命令');
  const holdGeneration = useRef(0);
  const holdTimer = useRef<number | null>(null);
  const holdingRef = useRef<Direction | null>(null);
  const armedRef = useRef(false);
  const fireGeneration = useRef(0);
  const fireTimer = useRef<number | null>(null);
  const fireHoldingRef = useRef(false);

  const applyPositionFromReply = useCallback((line: string) => {
    const match = line.match(/us=(\d+)/);
    if (!match) return;
    const pulse = Number(match[1]);
    setStatus((current) =>
      current
        ? line.includes('axis=FIRE')
          ? { ...current, fire_us: pulse, fire_active: pulse === 2000 }
          : line.includes('axis=CH2')
          ? { ...current, ch2_us: pulse }
          : line.includes('axis=CH1')
            ? { ...current, ch1_us: pulse }
            : current
        : current,
    );
  }, []);

  const transmit = useCallback(
    async (command: CommandName) => {
      const response = await fetch(`${API_BASE}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? '命令执行失败');
      }
      const line = String(payload.responses?.[0] ?? '');
      applyPositionFromReply(line);
      setOnline(true);
      return line;
    },
    [applyPositionFromReply],
  );

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? '设备状态查询失败');
      }
      setStatus(payload.device);
      setOnline(true);
      if (!holdingRef.current && !fireHoldingRef.current && !armedRef.current) {
        const stopped = payload.device.ch1_motion === 'stopped'
          && payload.device.ch2_motion === 'stopped'
          && payload.device.fire_active === false;
        setMessage(stopped ? '设备已连接，设备报告已停止、未发射' : '设备已连接，请检查当前输出状态');
      }
    } catch (error) {
      setOnline(false);
      setStatus(null);
      setMessage(error instanceof Error ? error.message : '无法连接本机控制服务');
    } finally {
      setChecking(false);
    }
  }, []);

  const stopFire = useCallback(
    async (announce = true) => {
      const wasFiring = fireHoldingRef.current;
      fireGeneration.current += 1;
      fireHoldingRef.current = false;
      setFireHolding(false);
      if (fireTimer.current !== null) {
        window.clearTimeout(fireTimer.current);
        fireTimer.current = null;
      }
      try {
        const line = await transmit('FIRE_OFF');
        if (!line.startsWith('ACK FIRE_OFF')) throw new Error(line || '发射关闭未获有效回执');
        if (announce) {
          setMessage(wasFiring ? '已停止发射，CH3恢复1000 μs；保险保持解锁' : 'CH3已保持关闭，保险状态不变');
          setLastCommand(`停止发射 · ${new Date().toLocaleTimeString('zh-CN')}`);
        }
      } catch (error) {
        setOnline(false);
        setMessage(error instanceof Error ? error.message : '发射关闭命令发送失败');
      }
    },
    [transmit],
  );

  const lockFireInsurance = useCallback(() => {
    armedRef.current = false;
    setArmed(false);
    setMessage('发射保险已由用户锁定');
    setLastCommand(`锁定发射保险 · ${new Date().toLocaleTimeString('zh-CN')}`);
    void stopFire(false);
  }, [stopFire]);

  const stopHold = useCallback(
    async (announce = true) => {
      const previous = holdingRef.current;
      holdGeneration.current += 1;
      holdingRef.current = null;
      setHolding(null);
      fireGeneration.current += 1;
      fireHoldingRef.current = false;
      setFireHolding(false);
      if (holdTimer.current !== null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }

      try {
        const line = await transmit('STOP');
        if (announce) {
          setMessage('已停止全部动作：两轴保持当前位置，CH3关闭；保险状态不变');
          setLastCommand(`停止 · ${new Date().toLocaleTimeString('zh-CN')}`);
        }
        if (line.startsWith('ACK') && previous) {
          window.setTimeout(() => void refreshStatus(), 100);
        }
      } catch (error) {
        setOnline(false);
        setMessage(error instanceof Error ? error.message : '停止命令发送失败');
      }
    },
    [refreshStatus, transmit],
  );

  const startHold = useCallback(
    (direction: Direction) => {
      if (!online || armedRef.current || fireHoldingRef.current || holdingRef.current === direction) return;

      holdGeneration.current += 1;
      const generation = holdGeneration.current;
      holdingRef.current = direction;
      setHolding(direction);
      const directionText =
        direction === 'LEFT'
          ? '向左'
          : direction === 'RIGHT'
            ? '向右'
            : direction === 'UP'
              ? '向上'
              : '向下';
      setMessage(`按住${directionText}：目标位置持续移动；松开后保持`);
      setLastCommand(`${directionText}按住 · ${new Date().toLocaleTimeString('zh-CN')}`);

      const pump = async () => {
        if (generation !== holdGeneration.current || holdingRef.current !== direction) return;

        try {
          const line = await transmit(direction);
          if (line.startsWith('LIMIT')) {
            holdGeneration.current += 1;
            holdingRef.current = null;
            setHolding(null);
            setMessage(`${directionText}PWM软限位已到，当前位置保持`);
            setLastCommand(`${directionText}软限位 · ${new Date().toLocaleTimeString('zh-CN')}`);
            return;
          }
        } catch (error) {
          holdGeneration.current += 1;
          holdingRef.current = null;
          setHolding(null);
          setOnline(false);
          setMessage(error instanceof Error ? error.message : '持续控制命令失败');
          return;
        }

        if (generation === holdGeneration.current && holdingRef.current === direction) {
          holdTimer.current = window.setTimeout(pump, KEEPALIVE_DELAY_MS);
        }
      };

      void pump();
    },
    [online, transmit],
  );

  const confirmArmFire = useCallback(() => {
    if (!online || holdingRef.current || fireHoldingRef.current) return;
    setSafetyDialogOpen(false);
    armedRef.current = true;
    setArmed(true);
    setMessage('发射保险已由用户解除；按住发射，松开即停，保险保持解锁');
    setLastCommand(`解除发射保险 · ${new Date().toLocaleTimeString('zh-CN')}`);
  }, [online]);

  const startFire = useCallback(() => {
    if (!online || !armedRef.current || fireHoldingRef.current || holdingRef.current) return;

    fireGeneration.current += 1;
    const generation = fireGeneration.current;
    fireHoldingRef.current = true;
    setFireHolding(true);
    setMessage('正在发射：松开按钮立即停止，保险保持解锁');
    setLastCommand(`按住发射 · ${new Date().toLocaleTimeString('zh-CN')}`);

    const pump = async () => {
      if (generation !== fireGeneration.current || !fireHoldingRef.current) return;
      try {
        const line = await transmit('FIRE_ON');
        if (!line.startsWith('ACK FIRE_ON')) throw new Error(line || '发射命令未获有效回执');
      } catch (error) {
        fireGeneration.current += 1;
        fireHoldingRef.current = false;
        setFireHolding(false);
        setOnline(false);
        setMessage(error instanceof Error ? error.message : '持续发射命令失败');
        return;
      }
      if (generation === fireGeneration.current && fireHoldingRef.current) {
        fireTimer.current = window.setTimeout(pump, KEEPALIVE_DELAY_MS);
      }
    };

    void pump();
  }, [online, transmit]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!holdingRef.current && !fireHoldingRef.current) void refreshStatus();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!event.repeat) startHold('LEFT');
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!event.repeat) startHold('RIGHT');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!event.repeat) startHold('UP');
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!event.repeat) startHold('DOWN');
      } else if (event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        void stopHold();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (
        (event.key === 'ArrowLeft' && holdingRef.current === 'LEFT') ||
        (event.key === 'ArrowRight' && holdingRef.current === 'RIGHT') ||
        (event.key === 'ArrowUp' && holdingRef.current === 'UP') ||
        (event.key === 'ArrowDown' && holdingRef.current === 'DOWN')
      ) {
        event.preventDefault();
        void stopHold();
      }
    };
    const onBlur = () => {
      if (fireHoldingRef.current) void stopFire(false);
      else if (holdingRef.current) void stopHold(false);
    };
    const onVisibility = () => {
      if (!document.hidden) return;
      if (fireHoldingRef.current) void stopFire(false);
      else if (holdingRef.current) void stopHold(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [startHold, stopFire, stopHold]);

  const pulse = status?.ch1_us ?? 1500;
  const ch2Pulse = status?.ch2_us ?? 1500;
  const rightLimit = status?.ch1_right_limit_us ?? 1000;
  const leftLimit = status?.ch1_left_limit_us ?? 2000;
  const upLimit = status?.ch2_up_limit_us ?? 2000;
  const downLimit = status?.ch2_down_limit_us ?? 1000;
  const center = status?.center_us ?? 1500;
  const positionPercent = Math.max(
    0,
    Math.min(100, ((leftLimit - pulse) / (leftLimit - rightLimit)) * 100),
  );
  const ch2PositionPercent = Math.max(
    0,
    Math.min(100, ((downLimit - ch2Pulse) / (downLimit - upLimit)) * 100),
  );

  const currentAction =
    holding === 'LEFT'
      ? '向左'
      : holding === 'RIGHT'
        ? '向右'
        : holding === 'UP'
          ? '向上'
          : holding === 'DOWN'
            ? '向下'
            : '已停止';

  const directionButtonProps = (direction: Direction) => ({
    disabled: !online || armed || fireHolding,
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      startHold(direction);
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      void stopHold();
    },
    onPointerCancel: () => void stopHold(false),
    onLostPointerCapture: () => {
      if (holdingRef.current === direction) void stopHold(false);
    },
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  });

  const fireButtonProps = {
    disabled: !online || !armed || holding !== null,
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      startFire();
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (fireHoldingRef.current) void stopFire();
    },
    onPointerCancel: () => {
      if (fireHoldingRef.current) void stopFire(false);
    },
    onLostPointerCapture: () => {
      if (fireHoldingRef.current) void stopFire(false);
    },
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  };

  return (
    <main className="min-h-screen bg-background px-4 py-5 text-foreground sm:px-8 sm:py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card/80 p-5 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
              <Crosshair className="size-6" aria-hidden="true" />
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">Local control surface</p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">遥控枪控制台</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={online ? 'default' : 'destructive'} className="h-7 px-3">
              <span className={`size-2 rounded-full ${online ? 'bg-emerald-300' : 'bg-red-400'}`} />
              {online ? '设备在线' : '设备离线'}
            </Badge>
            <Badge variant="outline" className="h-7 px-3">
              {isUsb ? <Cable data-icon="inline-start" /> : <Bluetooth data-icon="inline-start" />}
              {transportLabel}
            </Badge>
          </div>
        </header>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
          <Card className="border border-border/70 bg-card/90 shadow-2xl shadow-black/15">
            <CardHeader className="border-b border-border/60">
              <CardTitle className="flex items-center gap-2 text-lg"><Radio className="size-5 text-primary" />方向控制</CardTitle>
              <CardDescription>按住时逐步改变舵机目标位置，松开后保持最后位置；PWM边界限制最大偏转。</CardDescription>
            </CardHeader>
            <CardContent className="py-6">
              <div className="mx-auto grid max-w-md grid-cols-3 gap-3">
                <div />
                <Button {...directionButtonProps('UP')} aria-label="按住向上，松开保持" className={`h-20 touch-none select-none flex-col gap-1.5 bg-violet-400 text-slate-950 hover:bg-violet-300 ${holding === 'UP' ? 'ring-4 ring-violet-200/60' : ''}`}><ArrowUp className="size-7" /><span>按住向上</span></Button>
                <div />

                <Button {...directionButtonProps('LEFT')} aria-label="按住向左，松开停止" className={`h-24 touch-none select-none flex-col gap-2 bg-cyan-500 text-slate-950 hover:bg-cyan-400 ${holding === 'LEFT' ? 'ring-4 ring-cyan-200/60' : ''}`}>
                  <ArrowLeft className="size-8" /><span>按住向左</span><kbd className="text-[10px] opacity-70">←</kbd>
                </Button>

                <Button variant="destructive" onClick={() => void stopHold()} aria-label="紧急停止全部输出" className="h-24 flex-col gap-2 border border-red-400/40 bg-red-500/20 text-red-200 hover:bg-red-500/30">
                  <CircleStop className="size-9" /><span>全部停止</span><kbd className="text-[10px] opacity-70">空格 / Esc</kbd>
                </Button>

                <Button {...directionButtonProps('RIGHT')} aria-label="按住向右，松开停止" className={`h-24 touch-none select-none flex-col gap-2 bg-cyan-500 text-slate-950 hover:bg-cyan-400 ${holding === 'RIGHT' ? 'ring-4 ring-cyan-200/60' : ''}`}>
                  <ArrowRight className="size-8" /><span>按住向右</span><kbd className="text-[10px] opacity-70">→</kbd>
                </Button>

                <div />
                <Button {...directionButtonProps('DOWN')} aria-label="按住向下，松开保持" className={`h-20 touch-none select-none flex-col gap-1.5 bg-violet-400 text-slate-950 hover:bg-violet-300 ${holding === 'DOWN' ? 'ring-4 ring-violet-200/60' : ''}`}><ArrowDown className="size-7" /><span>按住向下</span></Button>
                <div />
              </div>

              <div className="mx-auto mt-7 max-w-md rounded-xl border border-border/60 bg-background/35 p-4">
                <p className="mb-2 text-xs font-medium text-cyan-200">水平 CH1</p>
                <div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>左限位 {leftLimit} μs</span><span>中点 {center} μs</span><span>右限位 {rightLimit} μs</span></div>
                <div className="relative h-3 overflow-hidden rounded-full bg-muted">
                  <div className="absolute left-1/2 top-0 h-full w-px bg-foreground/50" />
                  <div className="absolute top-0 size-3 -translate-x-1/2 rounded-full bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,.8)]" style={{ left: `${positionPercent}%` }} />
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">当前目标脉宽：{pulse} μs（安全范围 {rightLimit}–{leftLimit} μs）</p>
                <div className="my-4 border-t border-border/60" />
                <p className="mb-2 text-xs font-medium text-violet-200">俯仰 CH2</p>
                <div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>向下限位 {downLimit} μs</span><span>中点 {center} μs</span><span>向上限位 {upLimit} μs</span></div>
                <div className="relative h-3 overflow-hidden rounded-full bg-muted">
                  <div className="absolute left-1/2 top-0 h-full w-px bg-foreground/50" />
                  <div className="absolute top-0 size-3 -translate-x-1/2 rounded-full bg-violet-300 shadow-[0_0_12px_rgba(196,181,253,.8)]" style={{ left: `${ch2PositionPercent}%` }} />
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">当前目标脉宽：{ch2Pulse} μs（范围 {downLimit}–{upLimit} μs）</p>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-5">
            <Card className="border border-border/70 bg-card/90">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-emerald-400" />安全状态</CardTitle>
                <CardDescription>断连、页面失焦或心跳超时会停止改变目标，并保持当前位置。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatusRow label="通信" value={online ? transportLabel : '未连接'} />
                <StatusRow label="水平CH1" value={`${status?.ch1_us ?? '—'} μs`} />
                <StatusRow label="当前动作" value={currentAction} />
                <StatusRow label="移动速度" value={`${status?.ramp_us_per_second ?? 100} μs/s`} />
                <StatusRow label="失联保持" value={`${status?.watchdog_ms ?? 300} ms`} />
                <StatusRow label="俯仰CH2" value={`${status?.ch2_us ?? '—'} μs`} />
                <StatusRow label="发射CH3" value={`${status?.fire_us ?? 1000} μs · ${status?.fire_active ? '发射中' : '已关闭'}`} />
              </CardContent>
            </Card>

            <Card className={`border ${armed ? 'border-red-400/60 bg-red-400/10' : 'border-amber-400/30 bg-amber-400/5'}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-amber-100"><LockKeyhole className="size-5 text-amber-300" />CH3发射控制</CardTitle>
                <CardDescription className="text-amber-100/60">先解除保险，再按住发射；松开、失焦、断连或心跳超时均恢复1000μs。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <StatusRow label="CH3当前输出" value={`${status?.fire_us ?? 1000} μs`} />
                <StatusRow label="发射保险" value={armed ? '已解除 · 等待用户锁定' : '已锁定'} />
                <StatusRow label="失联关闭" value={`${status?.fire_watchdog_ms ?? 300} ms`} />
                <Button
                  disabled={!online || checking || holding !== null || fireHolding}
                  variant="outline"
                  onClick={armed ? lockFireInsurance : () => setSafetyDialogOpen(true)}
                  className="h-12 w-full border-amber-300/40 text-amber-100 hover:bg-amber-300/10"
                >
                  <LockKeyhole /> {armed ? '重新锁定保险' : '解除发射保险'}
                </Button>
                <Button
                  {...fireButtonProps}
                  className={`h-16 w-full touch-none select-none bg-red-600 text-white hover:bg-red-500 ${fireHolding ? 'ring-4 ring-red-300/70' : ''}`}
                >
                  <Crosshair /> {fireHolding ? '发射中 · 松开即停' : '按住发射'}
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="grid gap-3 rounded-2xl border border-border/70 bg-card/70 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div><p className="text-sm font-medium" aria-live="polite">{message}</p><p className="mt-1 text-xs text-muted-foreground">最近操作：{lastCommand}</p></div>
          <Button variant="outline" disabled={checking || holding !== null || fireHolding} onClick={() => void refreshStatus()} className="justify-self-start sm:justify-self-end"><RefreshCw className={checking ? 'animate-spin' : ''} />刷新连接</Button>
        </section>

        <footer className="flex flex-col gap-1 px-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>CH1/CH2为1000–2000 μs、300 μs/s；CH3关闭1000 μs，发射2000 μs。</span>
          <span>电源顺序：ESP32先开，枪体后开；关闭时顺序相反。</span>
        </footer>

        <AlertDialog open={safetyDialogOpen} onOpenChange={setSafetyDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-amber-400/15 text-amber-300">
                <ShieldCheck />
              </AlertDialogMedia>
              <AlertDialogTitle>确认解除发射保险</AlertDialogTitle>
              <AlertDialogDescription>
                请确认枪口朝向安全区域、射击路径无人且已做好防护。解除后必须按住发射按钮才会发射；松开会立即停止输出，但保险保持解锁，直到你手动点击“重新锁定保险”。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmArmFire}
                className="bg-amber-500 text-slate-950 hover:bg-amber-400"
              >
                确认解除保险
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </main>
  );
}

function StatusRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-2.5 last:border-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${muted ? 'text-muted-foreground' : ''}`}>{value}</span>
    </div>
  );
}
