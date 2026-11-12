import { powerSaveBlocker } from "electron";

/**
 * 「有任务运行时保持唤醒」的系统侧实现。
 *
 * 渲染层只知道「现在有没有任务在跑」，不知道也不该知道怎么拦休眠：由主进程统一
 * 调系统 API 拿一份电源断言（power assertion）。
 *
 * 用 Electron 的 powerSaveBlocker（底层就是各平台的官方接口，不是我们另起进程）：
 *  · macOS —— IOPM 的 `IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep)`，
 *             即 `caffeinate -d` 做的那件事：屏幕不进休眠 → 不会因为空闲而锁屏；
 *  · Windows —— `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)`，
 *             阻止「电源计划里的显示器关闭 / 进入睡眠」，也就不会触发锁屏。
 *
 * 为什么是 prevent-display-sleep 而不是 prevent-app-suspension：后者只保证系统不休眠，
 * 屏幕照样会黑，黑了就按系统的「恢复时要求密码」锁上，达不到「不要被锁屏」的要求。
 *
 * 断言是进程级的：同一时间只保留一个 id，所有任务跑完（或开关关掉、应用退出）就 stop，
 * 把电源策略原样还给系统。
 */

let blockerId: number | null = null;
/** 释放延迟定时器：放在主进程而不是渲染层，是为了不受窗口隐藏时的定时器节流影响。 */
let releaseTimer: NodeJS.Timeout | null = null;

/** 一轮任务结束到下一轮开始常常只隔几百毫秒，太快释放会来回折腾系统的电源策略。 */
const RELEASE_DELAY_MS = 1500;

/** 当前是否真的拿着断言（用于日志与幂等判断，避免重复 start / stop 打扰系统）。 */
function holding(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
}

function clearReleaseTimer(): void {
  if (!releaseTimer) return;
  clearTimeout(releaseTimer);
  releaseTimer = null;
}

function acquire(): void {
  clearReleaseTimer();
  if (holding()) return;
  try {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
    console.log("[launcher] 有任务运行，已请求系统保持唤醒（阻止休眠 / 锁屏）");
  } catch (error) {
    blockerId = null;
    console.warn("[launcher] 请求系统保持唤醒失败，任务继续运行：", error);
  }
}

function release(): void {
  clearReleaseTimer();
  if (blockerId === null) return;
  try {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    console.log("[launcher] 任务已结束，已释放系统保持唤醒");
  } catch (error) {
    console.warn("[launcher] 释放系统保持唤醒失败：", error);
  }
  blockerId = null;
}

/**
 * 渲染层每次「需不需要保持唤醒」变化时调用 = 开关打开 && 还有任务在跑。
 * 幂等：重复传同一个值不会反复 start / stop；传 false 时延迟一会儿再释放。
 */
export function setKeepAwake(active: boolean): boolean {
  if (active === true) {
    acquire();
    return holding();
  }
  // 已经没在保持唤醒了，不必再排一次释放。
  if (blockerId === null) {
    clearReleaseTimer();
    return false;
  }
  if (!releaseTimer) releaseTimer = setTimeout(release, RELEASE_DELAY_MS);
  return holding();
}

/**
 * 立即释放（不等延迟）：应用退出、窗口销毁、渲染进程崩溃时用。
 * 这些场景不会再有人上报任务了，断言不能跟着一个没有任务的进程留着。
 */
export function releaseKeepAwake(): void {
  release();
}
