/**
 * 未登录播放限制（访客模式）
 *
 * 对应平台未登录时：
 * - 会员歌曲不做插件音源兜底，直接提示需要会员
 * - 非会员歌曲每首最多播放 1 分钟，到点暂停
 * - 每日累计播放时长上限 30 分钟，用完当日不再播放受限平台歌曲
 *
 * 额度只累计受限平台的墙钟播放时间，按天持久化在 localStorage；
 * 拦截判断不修改状态，实际暂停由 events.ts / play() 调用方执行
 */

import type { Track } from "@shared/types/player";
import type { Platform } from "@shared/types/platform";
import { ErrorCode } from "@shared/types/errors";
import { useUserStore } from "@/stores/user";
import { useDataStore } from "@/stores/data";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import * as playback from "@/services/playback";
import { toast } from "@/composables/useToast";
import i18n from "@/i18n";

/** 未登录单曲试听上限（毫秒） */
const TRACK_TRIAL_MS = 60_000;
/** 未登录每日试听总额度（毫秒） */
const DAILY_BUDGET_MS = 30 * 60_000;
/** 额度落盘最小间隔 */
const FLUSH_INTERVAL_MS = 5_000;

/** 额度持久化键 */
const USAGE_STORAGE_KEY = "splayer:guest-usage";

/** 额度持久化记录 */
interface UsageRecord {
  /** 记录归属日期（本地时区 YYYY-MM-DD） */
  date: string;
  /** 当日已累计的受限平台播放毫秒数 */
  ms: number;
}

/** 当日额度（本地时区） */
let usage = loadUsage();
/** 进入 playing 的墙钟时刻，null 表示未在计时 */
let playingSince: number | null = null;
/** 上次落盘时间 */
let lastFlushAt = 0;
/** 每日额度提示已发出（会话内一次） */
let dailyNotified = false;
/** 已到单曲上限并提示过的曲目 key，切歌后清除 */
let cappedTrackKey: string | null = null;
/** 安装标记 */
let installed = false;

/** 当日日期键（本地时区） */
export function todayKey(): string {
  const now = new Date();
  return (
    `${now.getFullYear()}-` +
    `${String(now.getMonth() + 1).padStart(2, "0")}-` +
    `${String(now.getDate()).padStart(2, "0")}`
  );
}

/** 读取当日额度记录，跨天自动归零 */
function loadUsage(): UsageRecord {
  const today = todayKey();
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return { date: today, ms: 0 };
    const parsed = JSON.parse(raw) as UsageRecord;
    if (parsed?.date !== today) return { date: today, ms: 0 };
    return { date: today, ms: Number(parsed.ms) || 0 };
  } catch {
    return { date: today, ms: 0 };
  }
}

/** 累计额度并按间隔落盘 */
function addUsage(ms: number): void {
  if (usage.date !== todayKey()) {
    usage = { date: todayKey(), ms: 0 };
  }
  usage.ms += ms;
  const now = Date.now();
  if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
    lastFlushAt = now;
    flushUsage();
  }
}

/** 落盘当前额度 */
function flushUsage(): void {
  try {
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usage));
  } catch {
    /* ignore */
  }
}

/** 含在途区间的当日已用额度 */
const usedMs = (): number => usage.ms + (playingSince !== null ? Date.now() - playingSince : 0);

/** 结清进行中的 playing 区间进额度 */
const settle = (): void => {
  if (playingSince === null) return;
  addUsage(Date.now() - playingSince);
  playingSince = null;
};

/** 每日额度提示（会话内一次） */
const notifyDaily = (): void => {
  if (dailyNotified) return;
  dailyNotified = true;
  toast.error(i18n.global.t("errors.GUEST_DAILY_LIMIT"));
};

/** 单曲上限提示（同曲一次，切歌后可再提示） */
const notifyTrial = (key: string): void => {
  if (cappedTrackKey === key) return;
  cappedTrackKey = key;
  toast.error(i18n.global.t("errors.GUEST_TRIAL_LIMIT"));
};

/** 曲目身份标识 */
const trackKeyOf = (track: Track): string => `${track.source}:${track.id}`;

/**
 * 平台未登录判定
 * @param platform - 平台标识
 * @returns 该平台未登录时为 true
 */
export const isGuestFor = (platform: Platform): boolean => {
  if (platform === "netease") return !useUserStore().isLoggedIn;
  if (platform === "qqmusic" || platform === "kugou") {
    return !useDataStore().getPlatformProfile(platform);
  }
  return false;
};

/**
 * 曲目受访客限制的判定
 * @param track - 要判定的曲目
 * @returns 曲目所属平台未登录时为 true，并收窄 null
 */
export const isTrackLimited = (track: Track | null): track is Track => {
  if (!track) return false;
  const source = track.source;
  if (source === "netease" || source === "qqmusic" || source === "kugou") {
    return isGuestFor(source);
  }
  return false;
};

/**
 * 曲目开始播放前的额度拦截，供音源解析入口调用
 * @param track - 要开始播放的曲目
 * @returns 拦截错误码；未拦截返回 null
 */
export const checkTrackStart = (track: Track): ErrorCode | null => {
  if (!isTrackLimited(track)) return null;
  if (usedMs() >= DAILY_BUDGET_MS) {
    notifyDaily();
    return ErrorCode.GUEST_DAILY_LIMIT;
  }
  return null;
};

/**
 * 恢复播放（play）前的拦截，检查当前曲目
 * @returns 是否拦截本次播放
 */
export const checkResume = (): boolean => {
  const track = useMediaStore().track;
  if (!isTrackLimited(track)) return false;
  if (usedMs() >= DAILY_BUDGET_MS) {
    notifyDaily();
    return true;
  }
  if (playback.getCurrentTime() >= TRACK_TRIAL_MS) {
    notifyTrial(trackKeyOf(track));
    return true;
  }
  return false;
};

/**
 * position 事件驱动的播放中强制暂停判定
 * @param positionMs - 当前播放位置（毫秒）
 * @returns 需要暂停时返回 "pause"
 */
export const onPosition = (positionMs: number): "pause" | null => {
  const track = useMediaStore().track;
  if (!isTrackLimited(track)) return null;
  if (usedMs() >= DAILY_BUDGET_MS) {
    notifyDaily();
    return "pause";
  }
  if (positionMs >= TRACK_TRIAL_MS) {
    notifyTrial(trackKeyOf(track));
    return "pause";
  }
  return null;
};

/** 安装访客限制：额度累计 watcher 与退出前落盘 */
export const installGuestLimit = (): void => {
  if (installed) return;
  installed = true;
  const status = useStatusStore();
  const media = useMediaStore();

  // 曲目切换后解除同曲去重，换曲重新允许 1 分钟试听；
  // 若播放未中断，按新曲目的受限状态重启计时，避免不受限曲目被计入额度
  watch(
    () => (media.track ? trackKeyOf(media.track) : null),
    () => {
      cappedTrackKey = null;
      dailyNotified = false;
      if (playingSince !== null) {
        settle();
        if (status.state === "playing" && isTrackLimited(media.track)) {
          playingSince = Date.now();
        }
      }
    },
  );

  // 播放态驱动额度累计（墙钟），窗口隐藏时也准确；
  // 额度用完后的停止由下个 position 事件（≤200ms 内）兜底
  watch(
    () => status.state,
    (state) => {
      if (state === "playing") {
        if (isTrackLimited(media.track)) playingSince = Date.now();
      } else {
        settle();
      }
    },
  );

  window.addEventListener("beforeunload", () => {
    settle();
    flushUsage();
  });
};
