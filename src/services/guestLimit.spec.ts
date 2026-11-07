import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import { ErrorCode } from "@shared/types/errors";
import { todayKey } from "./guestLimit";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  playbackTime: 0,
  playState: "paused",
  neteaseLoggedIn: false,
  qqProfile: null as unknown,
  track: null as Track | null,
}));

vi.mock("@/composables/useToast", () => ({ toast: { error: mocks.toast } }));
vi.mock("@/i18n", () => ({
  default: { global: { t: (key: string) => key } },
}));
vi.mock("@/services/playback", () => ({ getCurrentTime: () => mocks.playbackTime }));
vi.mock("@/stores/status", () => ({
  useStatusStore: () => ({ state: mocks.playState }),
}));
vi.mock("@/stores/user", () => ({
  useUserStore: () => ({ isLoggedIn: mocks.neteaseLoggedIn }),
}));
vi.mock("@/stores/data", () => ({
  useDataStore: () => ({ getPlatformProfile: () => mocks.qqProfile }),
}));
vi.mock("@/stores/media", () => ({
  useMediaStore: () => ({ track: mocks.track }),
}));

/** 重新加载被测模块，使模块级额度状态从 localStorage 重新初始化 */
const loadGuestLimit = async (): Promise<typeof import("./guestLimit")> => {
  vi.resetModules();
  return await import("./guestLimit");
};

/** 写入额度持久化记录 */
const seedUsage = (date: string, ms: number): void => {
  localStorage.setItem("splayer:guest-usage", JSON.stringify({ date, ms }));
};

const neteaseTrack: Track = { id: "1", title: "歌曲", source: "netease", artists: [], duration: 0 };

describe("未登录播放限制", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.playbackTime = 0;
    mocks.playState = "paused";
    mocks.neteaseLoggedIn = false;
    mocks.qqProfile = null;
    mocks.track = null;
  });

  it("对应平台未登录时受限，登录后解除", async () => {
    const { isTrackLimited } = await loadGuestLimit();
    expect(isTrackLimited(neteaseTrack)).toBe(true);
    mocks.neteaseLoggedIn = true;
    expect(isTrackLimited(neteaseTrack)).toBe(false);
  });

  it("QQ 音乐按独立登录态判定", async () => {
    const { isTrackLimited } = await loadGuestLimit();
    const track: Track = { id: "3", title: "歌曲", source: "qqmusic", artists: [], duration: 0 };
    expect(isTrackLimited(track)).toBe(true);
    mocks.qqProfile = { uid: "1" };
    expect(isTrackLimited(track)).toBe(false);
  });

  it("本地文件不受限", async () => {
    const { isTrackLimited } = await loadGuestLimit();
    const localTrack: Track = { ...neteaseTrack, source: "local", path: "C:/a.mp3" };
    expect(isTrackLimited(localTrack)).toBe(false);
  });

  it("额度用完后拦截并只提示一次", async () => {
    seedUsage(todayKey(), 30 * 60_000);
    const { checkTrackStart } = await loadGuestLimit();
    expect(checkTrackStart(neteaseTrack)).toBe(ErrorCode.GUEST_DAILY_LIMIT);
    expect(checkTrackStart(neteaseTrack)).toBe(ErrorCode.GUEST_DAILY_LIMIT);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("昨日额度不结转", async () => {
    seedUsage("2000-01-01", 30 * 60_000);
    const { checkTrackStart } = await loadGuestLimit();
    expect(checkTrackStart(neteaseTrack)).toBeNull();
  });

  it("已登录平台不检查额度", async () => {
    seedUsage(todayKey(), 30 * 60_000);
    mocks.neteaseLoggedIn = true;
    const { checkTrackStart } = await loadGuestLimit();
    expect(checkTrackStart(neteaseTrack)).toBeNull();
  });

  it("播放到 1 分钟返回暂停动作，同曲只提示一次", async () => {
    const { onPosition } = await loadGuestLimit();
    mocks.track = neteaseTrack;
    expect(onPosition(59_999)).toBeNull();
    expect(onPosition(60_000)).toBe("pause");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(onPosition(61_000)).toBe("pause");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("额度用完时优先触发每日限制", async () => {
    seedUsage(todayKey(), 30 * 60_000);
    mocks.track = neteaseTrack;
    const { onPosition } = await loadGuestLimit();
    expect(onPosition(1000)).toBe("pause");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("恢复播放超过试听点时拦截", async () => {
    mocks.track = neteaseTrack;
    mocks.playbackTime = 60_000;
    const { checkResume } = await loadGuestLimit();
    expect(checkResume()).toBe(true);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("未到试听点允许恢复播放", async () => {
    mocks.track = neteaseTrack;
    mocks.playbackTime = 30_000;
    const { checkResume } = await loadGuestLimit();
    expect(checkResume()).toBe(false);
  });
});
