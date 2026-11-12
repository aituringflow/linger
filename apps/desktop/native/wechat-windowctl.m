#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <unistd.h>
#include <signal.h>

static AXUIElementRef windowElement = NULL;
static pid_t wechatPid = 0;
static CGPoint originalPosition;
static CGSize originalSize;
static BOOL originalMinimized = NO;
static BOOL attached = NO;

static void sendResult(NSDictionary *result) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (data) { fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout); }
}
static NSDictionary *failure(NSString *message) { return @{ @"ok": @NO, @"error": message }; }
static id attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}
static BOOL pointValue(id value, CGPoint *point) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == AXValueGetTypeID() && AXValueGetValue((__bridge AXValueRef)value, kAXValueCGPointType, point);
}
static BOOL sizeValue(id value, CGSize *size) {
  return value && CFGetTypeID((__bridge CFTypeRef)value) == AXValueGetTypeID() && AXValueGetValue((__bridge AXValueRef)value, kAXValueCGSizeType, size);
}
static AXError setPoint(CGPoint point) {
  AXValueRef value = AXValueCreate(kAXValueCGPointType, &point);
  AXError result = AXUIElementSetAttributeValue(windowElement, kAXPositionAttribute, value);
  CFRelease(value); return result;
}
static AXError setSize(CGSize size) {
  AXValueRef value = AXValueCreate(kAXValueCGSizeType, &size);
  AXError result = AXUIElementSetAttributeValue(windowElement, kAXSizeAttribute, value);
  CFRelease(value); return result;
}
static BOOL restore(void) {
  if (!attached || !windowElement) return YES;
  // WeChat may ignore back-to-back geometry changes; let its last move settle first.
  usleep(400000);
  AXError sizeError = setSize(originalSize);
  AXError moveError = setPoint(originalPosition);
  BOOL minimized = [attribute(windowElement, kAXMinimizedAttribute) boolValue];
  AXError minimizeError = minimized == originalMinimized ? kAXErrorSuccess : AXUIElementSetAttributeValue(windowElement, kAXMinimizedAttribute, originalMinimized ? kCFBooleanTrue : kCFBooleanFalse);
  usleep(150000);
  CGPoint actualPoint; CGSize actualSize;
  BOOL matches = pointValue(attribute(windowElement, kAXPositionAttribute), &actualPoint) && sizeValue(attribute(windowElement, kAXSizeAttribute), &actualSize)
    && fabs(actualPoint.x-originalPosition.x) <= 2 && fabs(actualPoint.y-originalPosition.y) <= 2
    && fabs(actualSize.width-originalSize.width) <= 2 && fabs(actualSize.height-originalSize.height) <= 2;
  attached = NO;
  CFRelease(windowElement); windowElement = NULL;
  return moveError == kAXErrorSuccess && sizeError == kAXErrorSuccess && minimizeError == kAXErrorSuccess && matches;
}
static NSDictionary *attachWindow(void) {
  if (attached) return failure(@"微信窗口已连接。");
  NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
  if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options))
    return failure(@"请在系统设置 → 隐私与安全性 → 辅助功能中允许微信窗口控制，然后点击重新连接。首次授权后可能需要重启应用。");
  NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.tencent.xinWeChat"];
  if (apps.count != 1) return failure(@"请先打开并登录微信，确保只有一个微信进程，然后点击重新连接。");
  NSRunningApplication *app = apps.firstObject;
  AXUIElementRef application = AXUIElementCreateApplication(app.processIdentifier);
  NSArray *windows = attribute(application, kAXWindowsAttribute);
  if (![windows isKindOfClass:[NSArray class]] || windows.count == 0) {
    CFRelease(application); return failure(@"没有找到微信窗口。请先打开已登录的微信聊天窗口，再点击重新连接。");
  }
  // Prefer the main window when it is a usable chat-sized window. Otherwise choose the largest visible candidate.
  id mainWindow = attribute(application, kAXMainWindowAttribute);
  id chosen = nil; double largest = 0;
  for (id candidate in windows) {
    AXUIElementRef element = (__bridge AXUIElementRef)candidate;
    CGSize size; CGPoint position;
    if (!sizeValue(attribute(element, kAXSizeAttribute), &size) || !pointValue(attribute(element, kAXPositionAttribute), &position)) continue;
    NSString *title = attribute(element, kAXTitleAttribute);
    if ([title isKindOfClass:[NSString class]] && ([title containsString:@"登录"] || [title localizedCaseInsensitiveContainsString:@"log in"])) continue;
    if (size.width < 300 || size.height < 300 || [attribute(element, kAXMinimizedAttribute) boolValue]) continue;
    double area = size.width * size.height;
    if (candidate == mainWindow || (mainWindow && CFEqual((__bridge CFTypeRef)candidate, (__bridge CFTypeRef)mainWindow))) { chosen = candidate; break; }
    if (area > largest) { largest = area; chosen = candidate; }
  }
  if (!chosen) { CFRelease(application); return failure(@"没有找到已打开的微信聊天窗口。请恢复聊天窗口并登录后重试。"); }
  windowElement = (AXUIElementRef)CFRetain((__bridge CFTypeRef)chosen);
  wechatPid = app.processIdentifier;
  originalMinimized = [attribute(windowElement, kAXMinimizedAttribute) boolValue];
  if (!pointValue(attribute(windowElement, kAXPositionAttribute), &originalPosition) || !sizeValue(attribute(windowElement, kAXSizeAttribute), &originalSize)) {
    CFRelease(windowElement); windowElement = NULL; CFRelease(application); return failure(@"无法读取微信窗口的位置和尺寸。");
  }
  Boolean positionSettable = false, sizeSettable = false;
  AXUIElementIsAttributeSettable(windowElement, kAXPositionAttribute, &positionSettable);
  AXUIElementIsAttributeSettable(windowElement, kAXSizeAttribute, &sizeSettable);
  CFRelease(application);
  if (!positionSettable || !sizeSettable) { CFRelease(windowElement); windowElement = NULL; return failure(@"微信不允许调整当前窗口的位置或尺寸。"); }
  attached = YES;
  return @{ @"ok": @YES, @"pid": @(wechatPid), @"width": @(originalSize.width), @"height": @(originalSize.height) };
}
static NSDictionary *positionWindow(NSDictionary *command) {
  if (!attached || !windowElement) return failure(@"微信窗口未连接。");
  CGPoint point = CGPointMake([command[@"x"] doubleValue], [command[@"y"] doubleValue]);
  CGSize size = CGSizeMake([command[@"width"] doubleValue], [command[@"height"] doubleValue]);
  if (!isfinite(point.x) || !isfinite(point.y) || !isfinite(size.width) || !isfinite(size.height) || size.width < 100 || size.height < 100) return failure(@"无效的窗口位置或尺寸。");
  AXError resizeError = setSize(size);
  AXError moveError = setPoint(point);
  CGSize actualSize; CGPoint actualPoint;
  if (resizeError != kAXErrorSuccess || moveError != kAXErrorSuccess || !sizeValue(attribute(windowElement, kAXSizeAttribute), &actualSize) || !pointValue(attribute(windowElement, kAXPositionAttribute), &actualPoint))
    return failure(@"无法移动微信窗口，窗口可能已关闭。请重新连接。");
  if (fabs(actualSize.width-size.width) > 2 || fabs(actualSize.height-size.height) > 2 || fabs(actualPoint.x-point.x) > 2 || fabs(actualPoint.y-point.y) > 2)
    return failure(@"微信窗口无法调整到目标区域，请增大数域窗口后重新连接。");
  return @{ @"ok": @YES, @"width": @(actualSize.width), @"height": @(actualSize.height) };
}
static NSDictionary *showWindow(void) {
  if (!attached || !windowElement) return failure(@"微信窗口未连接。");
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:wechatPid];
  if (!app || app.terminated) return failure(@"微信已退出，请重新连接。");
  [app unhide];
  AXUIElementSetAttributeValue(windowElement, kAXMinimizedAttribute, kCFBooleanFalse);
  [app activateWithOptions:0];
  AXError error = AXUIElementPerformAction(windowElement, kAXRaiseAction);
  return error == kAXErrorSuccess ? @{ @"ok": @YES } : failure(@"无法显示微信窗口，请重新连接。");
}
static NSDictionary *inputWindow(NSDictionary *command, BOOL scroll) {
  if (!attached || !windowElement) return failure(@"微信窗口未连接。");
  CGPoint origin; CGSize size;
  if (!pointValue(attribute(windowElement, kAXPositionAttribute), &origin) || !sizeValue(attribute(windowElement, kAXSizeAttribute), &size)) return failure(@"微信窗口已关闭。");
  double x = [command[@"x"] doubleValue], y = [command[@"y"] doubleValue];
  double expectedWidth = [command[@"width"] doubleValue], expectedHeight = [command[@"height"] doubleValue];
  if (!isfinite(x) || !isfinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height || fabs(expectedWidth-size.width) > 2 || fabs(expectedHeight-size.height) > 2) return failure(@"微信窗口尺寸已变化，取消操作并等待下次消息。");
  CGPoint location = CGPointMake(origin.x + x, origin.y + y);
  // HID events follow screen z-order. Refuse to post unless this point belongs to
  // the visible frontmost WeChat app; otherwise a focus change could click another app.
  BOOL (^safeTarget)(void) = ^BOOL{
    if ([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier != wechatPid) return NO;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    for (NSDictionary *window in windows) {
      if ([window[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0.01) continue;
      CGRect frame;
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(__bridge NSString *)kCGWindowBounds], &frame) || !CGRectContainsPoint(frame, location)) continue;
      return [window[(__bridge NSString *)kCGWindowOwnerPID] intValue] == wechatPid
        && fabs(frame.origin.x-origin.x) <= 3 && fabs(frame.origin.y-origin.y) <= 3
        && fabs(frame.size.width-size.width) <= 3 && fabs(frame.size.height-size.height) <= 3;
    }
    return NO;
  };
  if (!safeTarget()) return failure(@"微信窗口不在前台或被遮挡，已取消操作。");
  if (scroll) {
    int count = [command[@"count"] intValue];
    if (count < 1 || count > 12) return failure(@"滚动次数无效。");
    NSString *direction = command[@"direction"] ?: @"up";
    if (![direction isEqualToString:@"up"] && ![direction isEqualToString:@"down"]) return failure(@"滚动方向无效。");
    for (int i = 0; i < count; i++) {
      if (!safeTarget()) return failure(@"微信窗口已失去焦点或被遮挡，已停止滚动。");
      CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, [direction isEqualToString:@"up"] ? 3 : -3);
      if (!event) return failure(@"无法创建滚动事件。");
      CGEventSetLocation(event, location); CGEventPost(kCGHIDEventTap, event); CFRelease(event); usleep(30000);
    }
  } else {
    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, location, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, location, kCGMouseButtonLeft);
    if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); return failure(@"无法创建点击事件。"); }
    CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up); CFRelease(down); CFRelease(up);
  }
  return @{ @"ok": @YES };
}
static NSDictionary *insertDraft(NSDictionary *command) {
  NSString *text = command[@"text"];
  if (![text isKindOfClass:[NSString class]] || text.length == 0 || text.length > 600) return failure(@"建议回复为空或过长，未填入微信。");
  for (NSUInteger i = 0; i < text.length; i++) {
    unichar c = [text characterAtIndex:i];
    // Never emit a Return, Tab, or another control character.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c == 0x2028 || c == 0x2029) return failure(@"建议回复包含换行或控制字符，未填入微信。");
  }
  NSDictionary *clicked = inputWindow(command, NO);
  if (![clicked[@"ok"] boolValue]) return clicked;
  usleep(120000);
  AXUIElementRef application = AXUIElementCreateApplication(wechatPid);
  id focused = attribute(application, kAXFocusedUIElementAttribute);
  BOOL canVerifyValue = NO;
  if (focused && CFGetTypeID((__bridge CFTypeRef)focused) == AXUIElementGetTypeID()) {
    AXUIElementRef element = (__bridge AXUIElementRef)focused;
    NSString *role = attribute(element, kAXRoleAttribute);
    if ([role isEqualToString:(__bridge NSString *)kAXTextFieldRole] || [role isEqualToString:(__bridge NSString *)kAXTextAreaRole]) {
      id value = attribute(element, kAXValueAttribute);
      if ([value isKindOfClass:[NSString class]]) {
        canVerifyValue = YES;
        if ([value length] > 0) { CFRelease(application); return failure(@"输入框已有草稿，未填入建议回复。"); }
      }
    }
  }
  CFRelease(application);
  __block BOOL failed = NO;
  [text enumerateSubstringsInRange:NSMakeRange(0, text.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString *part, NSRange substringRange, NSRange enclosingRange, BOOL *stop) {
    if ([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier != wechatPid || part.length > 20) { failed = YES; *stop = YES; return; }
    UniChar chars[20]; [part getCharacters:chars range:NSMakeRange(0, part.length)];
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true), up = CGEventCreateKeyboardEvent(NULL, 0, false);
    if (!down || !up) { if (down) CFRelease(down); if (up) CFRelease(up); failed = YES; *stop = YES; return; }
    CGEventSetFlags(down, 0); CGEventSetFlags(up, 0);
    CGEventKeyboardSetUnicodeString(down, part.length, chars); CGEventKeyboardSetUnicodeString(up, part.length, chars);
    CGEventPost(kCGHIDEventTap, down); CGEventPost(kCGHIDEventTap, up);
    CFRelease(down); CFRelease(up);
    usleep(4000);
  }];
  if (failed) return failure(@"输入过程中微信失去焦点或字符无法输入，请检查输入框中的内容。");
  if (canVerifyValue && focused) {
    usleep(200000);
    id value = attribute((__bridge AXUIElementRef)focused, kAXValueAttribute);
    if ([value isKindOfClass:[NSString class]]) {
      if (![value isEqualToString:text]) return failure(@"输入框内容未与建议回复一致，请检查微信中的草稿。");
      return @{ @"ok": @YES, @"verified": @YES };
    }
  }
  return @{ @"ok": @YES, @"verified": @NO };
}
int main(void) {
  @autoreleasepool {
    // The Electron parent handles Ctrl+C and asks us to restore the window.
    // Keep this helper alive until it receives that command or stdin closes.
    signal(SIGINT, SIG_IGN);
    char *line = NULL; size_t capacity = 0;
    while (getline(&line, &capacity, stdin) > 0) {
      @autoreleasepool {
        NSData *data = [[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *command = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSString *action = [command isKindOfClass:[NSDictionary class]] ? command[@"action"] : nil;
        NSDictionary *result;
        if ([action isEqualToString:@"attach"]) result = attachWindow();
        else if ([action isEqualToString:@"position"]) result = positionWindow(command);
        else if ([action isEqualToString:@"show"]) result = showWindow();
        else if ([action isEqualToString:@"click"]) result = inputWindow(command, NO);
        else if ([action isEqualToString:@"scroll"]) result = inputWindow(command, YES);
        else if ([action isEqualToString:@"draft"]) result = insertDraft(command);
        else if ([action isEqualToString:@"minimize"]) {
          AXError error = attached ? AXUIElementSetAttributeValue(windowElement, kAXMinimizedAttribute, kCFBooleanTrue) : kAXErrorFailure;
          result = error == kAXErrorSuccess ? @{ @"ok": @YES } : failure(@"无法最小化微信窗口。");
        }
        else if ([action isEqualToString:@"restore"]) result = restore() ? @{ @"ok": @YES } : failure(@"无法完全恢复微信原来的位置和尺寸。");
        else result = failure(@"未知的窗口操作。");
        sendResult(result);
      }
    }
    free(line); restore();
  }
  return 0;
}
