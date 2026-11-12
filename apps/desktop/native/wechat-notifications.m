#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>

static AXObserverRef observer = NULL;
static AXUIElementRef notificationApp = NULL;
static pid_t notificationPid = 0;
static NSMutableSet<NSString *> *visible = nil;
static NSUInteger generation = 0;
static BOOL initialized = NO;

static void emit(NSString *type, NSString *message) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"type": type, @"message": message} options:0 error:nil];
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}
static NSString *stringAttribute(AXUIElementRef element, CFStringRef name) {
  id value = attribute(element, name);
  if ([value isKindOfClass:[NSString class]]) return value;
  if ([value isKindOfClass:[NSAttributedString class]]) return [value string];
  return nil;
}
static BOOL isWechatSource(NSString *description) {
  if (![description isKindOfClass:[NSString class]]) return NO;
  NSString *clean = [description stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSArray *parts = [clean componentsSeparatedByCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@",，\n"]];
  NSString *first = [parts.firstObject stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  return [first isEqualToString:@"微信"] || [first caseInsensitiveCompare:@"WeChat"] == NSOrderedSame || [first caseInsensitiveCompare:@"Weixin"] == NSOrderedSame;
}
static NSString *fingerprint(NSString *description) {
  NSData *data = [description dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSUInteger i = 0; i < sizeof(hash); i++) [result appendFormat:@"%02x", hash[i]];
  return result;
}
static BOOL isBanner(AXUIElementRef element) {
  NSString *role = stringAttribute(element, kAXSubroleAttribute);
  return [@[@"AXNotificationCenterBanner", @"AXNotificationCenterBannerStack", @"AXNotificationCenterAlert", @"AXNotificationCenterAlertStack"] containsObject:role ?: @""];
}
static void collectBanners(AXUIElementRef element, NSUInteger depth, NSMutableSet<NSString *> *found) {
  if (depth >= 8) return;
  if (isBanner(element)) {
    NSString *description = stringAttribute(element, CFSTR("AXAttributedDescription"));
    if (isWechatSource(description)) [found addObject:fingerprint(description)];
  }
  id children = attribute(element, kAXChildrenAttribute);
  if ([children isKindOfClass:[NSArray class]]) for (id child in children) {
    if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) collectBanners((__bridge AXUIElementRef)child, depth + 1, found);
  }
}
static void sweep(void) {
  if (!notificationApp) return;
  id windows = attribute(notificationApp, kAXWindowsAttribute);
  if (![windows isKindOfClass:[NSArray class]]) return;
  NSMutableSet<NSString *> *found = [NSMutableSet set];
  for (id window in windows) if (CFGetTypeID((__bridge CFTypeRef)window) == AXUIElementGetTypeID()) collectBanners((__bridge AXUIElementRef)window, 0, found);
  if (initialized) for (NSString *item in found) if (![visible containsObject:item]) emit(@"change", @"检测到微信系统通知");
  visible = found; initialized = YES;
}
static void scheduleSweep(void) {
  NSUInteger current = ++generation;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ if (current == generation) sweep(); });
}
static void callback(AXObserverRef sender, AXUIElementRef element, CFStringRef notification, void *refcon) { scheduleSweep(); }
static void detachObserver(void) {
  generation++;
  if (observer) { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes); CFRelease(observer); observer = NULL; }
  if (notificationApp) { CFRelease(notificationApp); notificationApp = NULL; }
  notificationPid = 0; initialized = NO; [visible removeAllObjects];
}
static BOOL attachObserver(void) {
  detachObserver();
  if (!AXIsProcessTrusted()) { emit(@"error", @"系统通知监听需要辅助功能权限"); return NO; }
  NSRunningApplication *app = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.notificationcenterui"].firstObject;
  if (!app) { emit(@"error", @"无法找到 macOS 通知中心，窗口本地检测仍可用"); return NO; }
  notificationPid = app.processIdentifier;
  notificationApp = AXUIElementCreateApplication(notificationPid);
  if (AXObserverCreate(notificationPid, callback, &observer) != kAXErrorSuccess || !observer) { detachObserver(); emit(@"error", @"无法监听 macOS 通知中心，窗口本地检测仍可用"); return NO; }
  NSArray *names = @[(__bridge NSString *)kAXLayoutChangedNotification, (__bridge NSString *)kAXWindowCreatedNotification, (__bridge NSString *)kAXUIElementDestroyedNotification];
  BOOL arrivalRegistered = NO;
  for (NSString *name in names) {
    AXError result = AXObserverAddNotification(observer, notificationApp, (__bridge CFStringRef)name, NULL);
    if (result == kAXErrorSuccess && ![name isEqualToString:(__bridge NSString *)kAXUIElementDestroyedNotification]) arrivalRegistered = YES;
  }
  if (!arrivalRegistered) { detachObserver(); emit(@"error", @"系统通知没有可用的辅助功能事件，窗口本地检测仍可用"); return NO; }
  CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), kCFRunLoopCommonModes);
  sweep();
  emit(@"ready", @"微信系统通知监听已启动");
  return YES;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
      BOOL ok = isWechatSource(@"微信, 测试") && isWechatSource(@"WeChat, Test") && !isWechatSource(@"其他应用, 微信") && !isWechatSource(@"微信支付, 测试") && [fingerprint(@"微信, A") isEqual:fingerprint(@"微信, A")] && ![fingerprint(@"微信, A") isEqual:fingerprint(@"微信, B")];
      emit(ok ? @"ready" : @"error", ok ? @"通知来源与去重自检通过" : @"通知来源自检失败"); return ok ? 0 : 1;
    }
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    // Exit when the parent closes its pipe, including after a launcher crash.
    dispatch_source_t parentPipe = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(parentPipe, ^{ char byte; if (read(STDIN_FILENO, &byte, 1) <= 0) exit(0); });
    dispatch_resume(parentPipe);
    visible = [NSMutableSet set];
    attachObserver();
    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceDidTerminateApplicationNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
      if (app.processIdentifier == notificationPid) { detachObserver(); emit(@"error", @"系统通知中心已退出，等待重新启动"); }
    }];
    [[[NSWorkspace sharedWorkspace] notificationCenter] addObserverForName:NSWorkspaceDidLaunchApplicationNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
      if ([app.bundleIdentifier isEqualToString:@"com.apple.notificationcenterui"]) attachObserver();
    }];
    CFRunLoopRun();
    detachObserver();
  }
  return 0;
}
