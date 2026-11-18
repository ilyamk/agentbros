// Explicit preparation only: `pnpm media:prepare --engines matte` runs swiftc frame-matte.swift -o <engines>/matte/bin/frame-matte.
// Production accepts a prebuilt hash-pinned executable and never invokes Swift. Caller: src/lib/matte/vision.ts.
//
// Protocol: one JSON object on stdin, one JSON line on stdout.
//   {"version":1,"operation":"probe"}
//   {"version":1,"operation":"matte","kind":"subject"|"person","quality":"fast"|"balanced"|"accurate","frames":[{"input":"/abs.png","output":"/abs.png"}]}
// Each output is an 8-bit grey alpha PNG at the input's pixel size (255 = subject).
import Foundation
import Vision
import ImageIO
import CoreImage
import CoreVideo
import UniformTypeIdentifiers

enum Failure: Error { case invalid(String) }
func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.invalid(message) } }
func emit(_ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try require(data.count <= 4 * 1024 * 1024, "response exceeds 4 MiB")
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}

let version = ProcessInfo.processInfo.operatingSystemVersion
// VNGenerateForegroundInstanceMaskRequest needs macOS 14; person segmentation needs macOS 12.
let subjectAvailable: Bool = { if #available(macOS 14.0, *) { return true }; return false }()
let personAvailable: Bool = { if #available(macOS 12.0, *) { return true }; return false }()

func runtime() -> [String: Any] {
    return [
        "engine": "apple-vision-matte",
        "osVersion": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
        "osMajor": version.majorVersion,
        "subject": subjectAvailable ? "VNGenerateForegroundInstanceMaskRequest" : NSNull(),
        "person": personAvailable ? "VNGeneratePersonSegmentationRequest" : NSNull(),
    ]
}

func loadImage(_ file: String) throws -> CGImage {
    try require(file.hasPrefix("/"), "input must be absolute")
    let url = URL(fileURLWithPath: file)
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    try require(values.isRegularFile == true && (values.fileSize ?? Int.max) <= 256 * 1024 * 1024, "unsafe input file")
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.invalid("decode failed: \(file)") }
    try require(image.width > 0 && image.height > 0 && image.width * image.height <= 40_000_000, "image exceeds 40 MP")
    return image
}

/// Grey 8-bit pixels at width x height, from any single-channel CIImage.
func greyBytes(_ image: CIImage, width: Int, height: Int, context: CIContext) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: width * height)
    let space = CGColorSpaceCreateDeviceGray()
    bytes.withUnsafeMutableBytes { raw in
        context.render(image, toBitmap: raw.baseAddress!, rowBytes: width, bounds: CGRect(x: 0, y: 0, width: width, height: height), format: .L8, colorSpace: space)
    }
    return bytes
}

func writePng(_ bytes: [UInt8], width: Int, height: Int, to file: String) throws {
    try require(file.hasPrefix("/") && file.hasSuffix(".png"), "output must be an absolute .png")
    let data = Data(bytes) as CFData
    guard let provider = CGDataProvider(data: data), let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw Failure.invalid("mask image failed") }
    let url = URL(fileURLWithPath: file + ".tmp")
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw Failure.invalid("png writer failed") }
    CGImageDestinationAddImage(destination, image, nil)
    try require(CGImageDestinationFinalize(destination), "png write failed")
    _ = try? FileManager.default.removeItem(atPath: file)
    try FileManager.default.moveItem(atPath: file + ".tmp", toPath: file)
}

/// Vision runs on the Neural Engine by default. When the ANE has no free program slots (another process holds them),
/// the request fails with a transient error; the retry pins every stage to the CPU (macOS 14+).
var cpuFallbacks = 0
func perform(_ request: VNRequest, _ handler: VNImageRequestHandler) throws {
    do { try handler.perform([request]) } catch {
        guard #available(macOS 14.0, *), String(describing: error).contains("ANE") else { throw error }
        for (stage, devices) in try request.supportedComputeStageDevices {
            if let cpu = devices.first(where: { if case .cpu = $0 { return true }; return false }) { request.setComputeDevice(cpu, for: stage) }
        }
        try handler.perform([request])
        cpuFallbacks += 1
    }
}

/// Subject: every foreground instance Vision finds, scaled to the image. Nil when nothing salient is found.
func subjectMask(_ image: CGImage, context: CIContext) throws -> ([UInt8], Int)? {
    guard #available(macOS 14.0, *) else { throw Failure.invalid("subject matte needs macOS 14") }
    let request = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try perform(request, handler)
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else { return nil }
    let buffer = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
    let mask = CIImage(cvPixelBuffer: buffer)
    return (greyBytes(mask, width: image.width, height: image.height, context: context), observation.allInstances.count)
}

/// Person: Vision's person segmentation (one mask for all people), upscaled from its own resolution to the image.
func personMask(_ image: CGImage, quality: String, context: CIContext) throws -> ([UInt8], Int)? {
    guard #available(macOS 12.0, *) else { throw Failure.invalid("person matte needs macOS 12") }
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = quality == "fast" ? .fast : quality == "balanced" ? .balanced : .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try perform(request, handler)
    guard let observation = request.results?.first else { return nil }
    let buffer = observation.pixelBuffer
    let small = CIImage(cvPixelBuffer: buffer)
    let sx = CGFloat(image.width) / small.extent.width, sy = CGFloat(image.height) / small.extent.height
    let scaled = small.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
    return (greyBytes(scaled, width: image.width, height: image.height, context: context), 1)
}

do {
    let bytes = FileHandle.standardInput.readData(ofLength: 4 * 1024 * 1024 + 1)
    try require(bytes.count <= 4 * 1024 * 1024, "stdin exceeds 4 MiB")
    guard let input = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], input["version"] as? Int == 1, let operation = input["operation"] as? String else { throw Failure.invalid("invalid protocol") }
    if operation == "probe" {
        try require(Set(input.keys) == Set(["version", "operation"]), "unknown probe fields")
        try emit(runtime())
    } else {
        try require(operation == "matte" && Set(input.keys) == Set(["version", "operation", "kind", "quality", "frames"]), "unknown operation/fields")
        guard let kind = input["kind"] as? String, ["subject", "person"].contains(kind), let quality = input["quality"] as? String, ["fast", "balanced", "accurate"].contains(quality), let frames = input["frames"] as? [[String: Any]] else { throw Failure.invalid("invalid settings") }
        try require(!frames.isEmpty && frames.count <= 2048, "invalid frame count")
        try require(kind == "person" || subjectAvailable, "subject matte needs macOS 14 (VNGenerateForegroundInstanceMaskRequest)")
        let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        var results = [[String: Any]]()
        for frame in frames {
            try require(Set(frame.keys) == Set(["input", "output"]), "unknown frame fields")
            guard let inputFile = frame["input"] as? String, let outputFile = frame["output"] as? String else { throw Failure.invalid("invalid frame") }
            let started = Date()
            let image = try loadImage(inputFile)
            let found = kind == "subject" ? try subjectMask(image, context: context) : try personMask(image, quality: quality, context: context)
            let pixels = found?.0 ?? [UInt8](repeating: 0, count: image.width * image.height)
            try writePng(pixels, width: image.width, height: image.height, to: outputFile)
            var covered = 0
            for value in pixels where value >= 128 { covered += 1 }
            results.append(["output": outputFile, "width": image.width, "height": image.height, "instances": found?.1 ?? 0, "coverage": Double(covered) / Double(pixels.count), "ms": Date().timeIntervalSince(started) * 1000])
        }
        try emit(["version": 1, "runtime": runtime(), "cpuFallbacks": cpuFallbacks, "frames": results])
    }
} catch {
    FileHandle.standardError.write(Data("Vision matte failed: \(error)\n".utf8))
    exit(1)
}
