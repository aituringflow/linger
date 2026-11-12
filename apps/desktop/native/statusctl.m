/**
 * statusctl —— launcher 自绘状态栏的系统采集器（macOS，原生小工具）。
 *
 * 为什么需要它：状态栏上的三样东西，Chromium/Electron **没有**可用的 API ——
 *   · 电量：`navigator.getBattery()` 在 Electron 里不可靠（Chromium 已弱化该 API），
 *           而 `pmset -g batt` 要起进程 + 解析文本，还拿不到充放电细节；
 *   · Wi-Fi：macOS 14 起 SSID 需要定位权限，`networksetup`/`airport` 要么给红线文本要么被移除，
 *           信号强度更是完全没有命令行出口；
 *   · 输入法：没有任何 JS/Electron 接口能读「当前输入源」，只有 HIToolbox 的 TIS API。
 * 这三样都要走系统框架，所以做成一个几十 KB 的原生小工具，由主进程长驻拉起。
 *
 * 用法：
 *   statusctl            打印一次 JSON 后退出
 *   statusctl --watch    长驻，状态变化时按行输出 JSON（主进程读 stdout）
 *
 * 输出（单行 JSON，取不到的字段为 null）：
 *   {"ime":{"id":…,"name":…},
 *    "wifi":{"power":true,"connected":true,"rssi":-53,"ssid":null},
 *    "battery":{"percent":80,"charging":false,"ac":true,"minutes":-1}}
 *
 * 编译：scripts/build-statusctl.mjs（clang -framework Foundation/CoreWLAN/IOKit/Carbon）。
 * 注意：SSID 在 macOS 14+ 需要「定位服务」授权，未授权时 CWInterface.ssid 返回 nil，
 *       这不是 bug —— 状态栏只用信号强度，不显示 SSID。
 */
#import <Carbon/Carbon.h>
#import <CoreWLAN/CoreWLAN.h>
#import <Foundation/Foundation.h>
#import <IOKit/ps/IOPSKeys.h>
#import <IOKit/ps/IOPowerSources.h>
#import <math.h>

static NSDictionary *readWiFi(void) {
  @try {
    CWWiFiClient *client = [CWWiFiClient sharedWiFiClient];
    CWInterface *iface = client ? [client interface] : nil;
    if (!iface) return nil;
    BOOL power = [iface powerOn];
    NSInteger rssi = power ? [iface rssiValue] : 0;
    // 信号强度按 5 dBm 量化：状态栏只画「几格」，原始值每次采样都会抖 ±2，
    // 不量化的话 --watch 会每 800ms 输出一行（全是噪声）。
    if (rssi != 0) rssi = (NSInteger)llround((double)rssi / 5.0) * 5;
    NSString *ssid = power ? [iface ssid] : nil;
    // 有信号强度才算真正关联上（未关联时 CoreWLAN 给 0）。
    return @{
      @"power": @(power),
      @"connected": @(power && rssi != 0),
      @"rssi": @(rssi),
      @"ssid": ssid ?: (id)[NSNull null],
    };
  } @catch (NSException *e) {
    return nil;
  }
}

static NSDictionary *readBattery(void) {
  @try {
    CFTypeRef snapshot = IOPSCopyPowerSourcesInfo();
    if (!snapshot) return nil;
    CFArrayRef sources = IOPSCopyPowerSourcesList(snapshot);
    NSDictionary *info = nil;
    if (sources && CFArrayGetCount(sources) > 0) {
      // IOPSGetPowerSourceDescription 返回不持有的 CFDictionary，不能用 CFBridgingRelease（会过释放崩溃）。
      info = (__bridge NSDictionary *)IOPSGetPowerSourceDescription(snapshot, CFArrayGetValueAtIndex(sources, 0));
    }
    NSDictionary *result = nil;
    if (info) {
      NSNumber *current = info[@kIOPSCurrentCapacityKey];
      NSNumber *maximum = info[@kIOPSMaxCapacityKey];
      int percent = -1;
      if (current && maximum && maximum.intValue > 0) {
        percent = (int)lround(current.doubleValue * 100.0 / maximum.doubleValue);
      }
      NSString *state = info[@kIOPSPowerSourceStateKey];
      NSNumber *minutes = info[@kIOPSTimeToEmptyKey];
      result = @{
        @"percent": @(percent),
        @"charging": @([info[@kIOPSIsChargingKey] boolValue]),
        @"ac": @([state isEqualToString:(NSString *)CFSTR("AC Power")] || [state isEqualToString:@kIOPSACPowerValue]),
        @"minutes": @(minutes ? minutes.intValue : -1),
      };
    }
    if (sources) CFRelease(sources);
    CFRelease(snapshot);
    return result;
  } @catch (NSException *e) {
    return nil;
  }
}

static NSDictionary *readInputSource(void) {
  @try {
    TISInputSourceRef source = TISCopyCurrentKeyboardInputSource();
    if (!source) return nil;
    CFStringRef rawId = TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    CFStringRef rawName = TISGetInputSourceProperty(source, kTISPropertyLocalizedName);
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    if (rawId) result[@"id"] = (__bridge_transfer NSString *)CFStringCreateCopy(NULL, rawId);
    if (rawName) result[@"name"] = (__bridge_transfer NSString *)CFStringCreateCopy(NULL, rawName);
    CFRelease(source);
    return result.count ? result : nil;
  } @catch (NSException *e) {
    return nil;
  }
}

static NSString *stateLine(void) {
  NSMutableDictionary *state = [NSMutableDictionary dictionary];
  NSDictionary *ime = readInputSource();
  NSDictionary *wifi = readWiFi();
  NSDictionary *battery = readBattery();
  state[@"ime"] = ime ?: (id)[NSNull null];
  state[@"wifi"] = wifi ?: (id)[NSNull null];
  state[@"battery"] = battery ?: (id)[NSNull null];
  NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
  if (!data) return @"{}";
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static void emit(NSString *line) {
  printf("%s\n", line.UTF8String);
  fflush(stdout);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    BOOL watch = NO;
    for (int i = 1; i < argc; i++) {
      if (strcmp(argv[i], "--watch") == 0) watch = YES;
    }

    if (!watch) {
      emit(stateLine());
      return 0;
    }

    // 长驻模式：只在内容变化时输出一行，主进程据此推给渲染层。
    // 800ms 是为了让切输入法后状态栏几乎立刻跟手（Wi-Fi/电量变化本来就慢，多轮询几次无所谓）。
    NSString *last = nil;
    for (;;) {
      @autoreleasepool {
        NSString *line = stateLine();
        if (![line isEqualToString:last]) {
          emit(line);
          last = line;
        }
      }
      usleep(800 * 1000);
    }
  }
  return 0;
}
