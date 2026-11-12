import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import CoreImage
import Foundation
import ScreenCaptureKit

func emit(_ type: String, _ message: String = "", extra: [String: Any] = [:]) {
    var value: [String: Any] = ["type": type, "message": message]
    value.merge(extra) { _, new in new }
    if let data = try? JSONSerialization.data(withJSONObject: value), let line = String(data: data, encoding: .utf8) {
        print(line); fflush(stdout)
    }
}

struct Marker: Equatable {
    let x: Int
    let y: Int
    let count: Int
}
func hasNewMarker(_ current: [Marker], comparedTo old: [Marker]) -> Bool {
    current.contains { marker in
        !old.contains { abs($0.x - marker.x) <= 4 && abs($0.y - marker.y) <= 4 && abs($0.count - marker.count) <= 8 }
    }
}

// Analyze only the conversation-list part of the frame. The image never leaves this process.
func markers(_ buffer: CVPixelBuffer, scale: Int = 1) -> [Marker] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
    let width = CVPixelBufferGetWidth(buffer) / scale, height = CVPixelBufferGetHeight(buffer) / scale
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    guard width > 100 && height > 100 else { return [] }
    let pixels = base.assumingMemoryBound(to: UInt8.self)
    // Include the navigation rail: its Messages tab can have an unread badge
    // while the user is in Moments or another section.
    let x0 = 0, x1 = min(width - 1, Int(Double(width) * 0.36))
    let y0 = max(1, Int(Double(height) * 0.08)), y1 = min(height - 1, Int(Double(height) * 0.96))
    let w = x1 - x0, h = y1 - y0
    guard w > 0 && h > 0 else { return [] }
    var red = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            let i = (y + y0) * scale * stride + (x + x0) * scale * 4
            let b = Int(pixels[i]), g = Int(pixels[i + 1]), r = Int(pixels[i + 2])
            if r >= 160 && r > g * 3 / 2 && r > b * 3 / 2 && g < 135 && b < 135 { red[y * w + x] = 1 }
        }
    }
    var result: [Marker] = []
    var stack: [Int] = []
    for start in 0..<red.count where red[start] == 1 {
        red[start] = 0; stack.append(start)
        var minX = w, maxX = 0, minY = h, maxY = 0, count = 0
        while let index = stack.popLast() {
            let x = index % w, y = index / w
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y); count += 1
            if x > 0 && red[index - 1] == 1 { red[index - 1] = 0; stack.append(index - 1) }
            if x + 1 < w && red[index + 1] == 1 { red[index + 1] = 0; stack.append(index + 1) }
            if y > 0 && red[index - w] == 1 { red[index - w] = 0; stack.append(index - w) }
            if y + 1 < h && red[index + w] == 1 { red[index + w] = 0; stack.append(index + w) }
        }
        let bw = maxX - minX + 1, bh = maxY - minY + 1
        // Keep red dot or pill-shaped unread badges and reject isolated pixels and large images.
        if count >= 12 && bw >= 4 && bh >= 4 && bw <= 45 && bh <= 30 && count * 3 >= bw * bh {
            result.append(Marker(x: x0 + (minX + maxX) / 2, y: y0 + (minY + maxY) / 2, count: count))
        }
    }
    return result
}

final class Monitor: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "wechat.monitor.frames")
    var baseline: [Marker]?
    var pending: DispatchWorkItem?
    var pendingMarkers: [Marker]?
    var stream: SCStream?
    var latestBuffer: CVPixelBuffer?
    var pendingCaptures: [String: String] = [:]

    func capture(id: String, path: String, fresh: Bool) {
        queue.async {
            if !fresh, let buffer = self.latestBuffer { self.writeCapture(id: id, path: path, buffer: buffer); return }
            self.pendingCaptures[id] = path
            self.queue.asyncAfter(deadline: .now() + .seconds(5)) {
                guard self.pendingCaptures.removeValue(forKey: id) != nil else { return }
                emit("capture_error", "等待微信窗口的新画面超时，请重试。", extra: ["id": id])
            }
        }
    }
    func writeCapture(id: String, path: String, buffer: CVPixelBuffer) {
        let context = CIContext(options: nil)
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cgImage = context.createCGImage(image, from: image.extent),
              let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
            emit("capture_error", "无法生成微信截图。", extra: ["id": id]); return
        }
        do {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
            emit("capture", "截图完成", extra: ["id": id, "width": cgImage.width, "height": cgImage.height])
        } catch { emit("capture_error", "保存微信截图失败：\(error.localizedDescription)", extra: ["id": id]) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let code = (error as NSError).code
        let retryable = code == SCStreamError.failedApplicationConnectionInterrupted.rawValue || code == SCStreamError.failedApplicationConnectionInvalid.rawValue || code == SCStreamError.internalError.rawValue
        emit("error", "微信窗口捕获已停止：\(error.localizedDescription)", extra: ["retryable": retryable, "code": code])
        exit(1)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int else { return }
        if raw == SCFrameStatus.idle.rawValue {
            if let buffer = latestBuffer { let requests = pendingCaptures; pendingCaptures.removeAll(); for (id, path) in requests { writeCapture(id: id, path: path, buffer: buffer) } }
            return
        }
        guard raw == SCFrameStatus.complete.rawValue, let buffer = sampleBuffer.imageBuffer else { return }
        latestBuffer = buffer
        let requests = pendingCaptures; pendingCaptures.removeAll()
        for (id, path) in requests { writeCapture(id: id, path: path, buffer: buffer) }
        emit("frame", "")
        let current = markers(buffer, scale: 2)
        let frameWidth = CVPixelBufferGetWidth(buffer) / 2, frameHeight = CVPixelBufferGetHeight(buffer) / 2
        guard baseline != nil else { baseline = current; emit("ready", "正在本地监听微信未读标记"); return }
        if current == baseline { pending?.cancel(); pending = nil; pendingMarkers = nil; return }
        if current == pendingMarkers { return }
        pending?.cancel()
        pendingMarkers = current
        let task = DispatchWorkItem { [weak self] in
            guard let self = self, let old = self.baseline else { return }
            self.pending = nil; self.pendingMarkers = nil
            let changed = current.filter { hasNewMarker([$0], comparedTo: old) }.sorted { $0.y < $1.y }
            self.baseline = current
            for marker in changed {
                emit("change", "检测到新的未读标记", extra: ["x": marker.x, "y": marker.y, "width": frameWidth, "height": frameHeight])
            }
        }
        pending = task
        queue.asyncAfter(deadline: .now() + .milliseconds(600), execute: task)
    }
    func start(pid: pid_t, expected: CGRect) async throws {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            throw NSError(domain: "wechat.monitor", code: 1, userInfo: [NSLocalizedDescriptionKey: "请在系统设置的屏幕与系统音频录制中允许本应用，然后重新连接。"])
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.frame.width >= 300 && $0.frame.height >= 300 && $0.isOnScreen }
        func distance(_ window: SCWindow) -> CGFloat {
            abs(window.frame.minX - expected.minX) + abs(window.frame.minY - expected.minY) + abs(window.frame.width - expected.width) + abs(window.frame.height - expected.height)
        }
        guard let window = windows.min(by: { distance($0) < distance($1) }), distance(window) < 80 else {
            throw NSError(domain: "wechat.monitor", code: 2, userInfo: [NSLocalizedDescriptionKey: "找不到可捕获的微信聊天窗口，请恢复窗口后重新连接。"])
        }
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width) * 2
        config.height = Int(window.frame.height) * 2
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 3, timescale: 1)
        config.queueDepth = 3
        config.showsCursor = false
        let capture = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = capture
        emit("started", "正在启动微信窗口监听")
        try await capture.startCapture()
    }
}

if CommandLine.arguments.dropFirst().first == "--self-test" {
    var buffer: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, 600, 500, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess, let buffer = buffer else { exit(1) }
    func dot(_ x: Int, _ y: Int) {
        CVPixelBufferLockBaseAddress(buffer, [])
        let p = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let row = CVPixelBufferGetBytesPerRow(buffer)
        for dy in 0..<10 { for dx in 0..<10 { let i = (y + dy) * row + (x + dx) * 4; p[i] = 30; p[i + 1] = 30; p[i + 2] = 230; p[i + 3] = 255 } }
        CVPixelBufferUnlockBaseAddress(buffer, [])
    }
    let empty = markers(buffer)
    dot(100, 100)
    let first = markers(buffer)
    dot(100, 180)
    let second = markers(buffer)
    dot(10, 260)
    let withNavigationBadge = markers(buffer)
    guard empty.isEmpty, first.count == 1, second.count == 2, withNavigationBadge.count == 3, hasNewMarker(withNavigationBadge, comparedTo: second), hasNewMarker(first, comparedTo: empty), hasNewMarker(second, comparedTo: first), !hasNewMarker(first, comparedTo: second) else { emit("error", "未读标记检测自检失败"); exit(1) }
    emit("ready", "未读标记检测自检通过")
    exit(0)
}

if #available(macOS 12.3, *) {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 5, let pid = Int32(args[0]),
          let x = Double(args[1]), let y = Double(args[2]),
          let width = Double(args[3]), let height = Double(args[4]) else { emit("error", "缺少微信窗口信息。"); exit(1) }
    let monitor = Monitor()
    // ScreenCaptureKit requires a WindowServer connection even for a command-line helper.
    _ = NSApplication.shared
    DispatchQueue.global(qos: .utility).async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  value["action"] as? String == "capture", let id = value["id"] as? String,
                  let path = value["path"] as? String else { continue }
            monitor.capture(id: id, path: path, fresh: value["fresh"] as? Bool ?? false)
        }
        Task { try? await monitor.stream?.stopCapture(); exit(0) }
    }
    Task {
        do { try await monitor.start(pid: pid, expected: CGRect(x: x, y: y, width: width, height: height)) }
        catch { emit("error", error.localizedDescription); exit(1) }
    }
    dispatchMain()
} else {
    emit("error", "微信窗口监听需要 macOS 12.3 或更新版本。")
    exit(1)
}
