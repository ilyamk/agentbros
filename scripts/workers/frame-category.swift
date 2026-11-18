// Explicit preparation only: swiftc frame-category.swift -o /trusted/ignored/frame-category.
// Production accepts a prebuilt hash-pinned executable and never invokes Swift.
import Foundation
import Vision
import ImageIO
import CryptoKit
import Darwin

enum Failure: Error { case invalid(String) }
func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.invalid(message) } }
func emit(_ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try require(data.count <= 8 * 1024 * 1024, "response exceeds 8 MiB")
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func request() -> VNClassifyImageRequest {
    let r = VNClassifyImageRequest(); r.revision = 2; r.usesCPUOnly = true; r.regionOfInterest = CGRect(x: 0, y: 0, width: 1, height: 1); return r
}
func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func runtime() throws -> [String: Any] {
    guard #available(macOS 14.0, *) else { throw Failure.invalid("revision2 unavailable on this OS") }
    let configured = request()
    let ids = try configured.supportedIdentifiers().sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
    try require(!ids.isEmpty && ids.count <= 2048 && Set(ids).count == ids.count, "invalid taxonomy inventory")
    for id in ids { try require(!id.isEmpty && id.count <= 200 && !id.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }, "invalid taxonomy identifier") }
    return ["engine": "apple-vision-classification", "revision": 2, "osVersion": ProcessInfo.processInfo.operatingSystemVersionString, "inputPolicy": "classification-framework-default/full-image-region-v1", "regionOfInterest": ["x": configured.regionOfInterest.origin.x, "y": configured.regionOfInterest.origin.y, "width": configured.regionOfInterest.width, "height": configured.regionOfInterest.height], "cpuOnly": true, "orientationPolicy": "validated-jpeg-png-exif-1-through-8-v1", "taxonomy": ["identifiers": ids, "hash": sha(Data(ids.joined(separator: "\n").utf8))]]
}
// Finite descriptor reads: FIFO/symlink refusal before reading, no path-selected unbounded allocation.
func boundedImage(_ file: String, _ hash: String) throws -> Data {
    try require(file.hasPrefix("/") && hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, "invalid image pin")
    var ancestors = [(String, [UInt64])]()
    func pathIdentity(_ info: stat) -> [UInt64] { [UInt64(UInt32(bitPattern: info.st_dev)), UInt64(info.st_ino), UInt64(info.st_mode)] }
    var url = URL(fileURLWithPath: file)
    while true {
        var info = stat()
        try require(lstat(url.path, &info) == 0 && (info.st_mode & S_IFMT) != S_IFLNK, "image path alias unavailable")
        ancestors.append((url.path, pathIdentity(info)))
        let parent = url.deletingLastPathComponent(); if parent.path == url.path { break }; url = parent
    }
    func recheckAncestors() throws {
        for (path, expected) in ancestors {
            var info = stat()
            try require(lstat(path, &info) == 0 && (info.st_mode & S_IFMT) != S_IFLNK && pathIdentity(info) == expected, "image ancestor changed or aliased")
        }
    }
    let fd = open(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
    try require(fd >= 0, "image open failed"); defer { close(fd) }
    try recheckAncestors()
    var before = stat()
    try require(fstat(fd, &before) == 0 && (before.st_mode & S_IFMT) == S_IFREG && before.st_size > 0 && before.st_size <= 16 * 1024 * 1024, "image requires bounded regular file")
    var result = Data(); result.reserveCapacity(Int(before.st_size))
    var buffer = [UInt8](repeating: 0, count: 65536)
    while result.count < Int(before.st_size) {
        let remaining = min(buffer.count, Int(before.st_size) - result.count)
        let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, remaining) }
        try require(count > 0, "image changed during read"); result.append(contentsOf: buffer[0..<count])
    }
    let extra = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, 1) }
    var after = stat(), named = stat()
    try require(extra == 0 && fstat(fd, &after) == 0 && lstat(file, &named) == 0, "image changed during read")
    func identity(_ s: stat) -> [Int64] { [Int64(s.st_dev), Int64(bitPattern: UInt64(s.st_ino)), s.st_size, Int64(s.st_mtimespec.tv_sec), Int64(s.st_mtimespec.tv_nsec), Int64(s.st_ctimespec.tv_sec), Int64(s.st_ctimespec.tv_nsec), Int64(s.st_mode)] }
    try require(identity(before) == identity(after) && identity(before) == identity(named) && sha(result) == hash, "image checksum/identity mismatch")
    try recheckAncestors()
    return result
}
// ImageIO normalizes malformed EXIF orientation to 1. Validate declared values before decoding.
// Deliberately support only single-frame JPEG/PNG, whose orientation declarations we can bound and inspect.
func validateOrientation(_ data: Data, format: String) throws -> UInt32? {
    var declared: UInt32? = nil
    let bytes = [UInt8](data)
    func tiff(_ start: Int, _ end: Int) throws {
        try require(start >= 0 && start + 8 <= end && end <= bytes.count, "malformed EXIF header")
        let little = bytes[start] == 73 && bytes[start + 1] == 73
        try require(little || (bytes[start] == 77 && bytes[start + 1] == 77), "malformed EXIF byte order")
        func u16(_ p: Int) throws -> Int { try require(p >= start && p + 2 <= end, "malformed EXIF offset"); return little ? Int(bytes[p]) | Int(bytes[p+1]) << 8 : Int(bytes[p]) << 8 | Int(bytes[p+1]) }
        func u32(_ p: Int) throws -> Int { try require(p >= start && p + 4 <= end, "malformed EXIF offset"); return little ? Int(bytes[p]) | Int(bytes[p+1]) << 8 | Int(bytes[p+2]) << 16 | Int(bytes[p+3]) << 24 : Int(bytes[p]) << 24 | Int(bytes[p+1]) << 16 | Int(bytes[p+2]) << 8 | Int(bytes[p+3]) }
        try require(try u16(start + 2) == 42, "malformed EXIF TIFF marker")
        let offset = try u32(start + 4); if offset == 0 { return }
        let ifd = start + offset, count = try u16(ifd)
        try require(count <= 4096 && ifd + 2 + count * 12 + 4 <= end, "malformed EXIF directory")
        var seen = false
        for i in 0..<count {
            let entry = ifd + 2 + i * 12
            if try u16(entry) == 0x112 {
                try require(!seen && (try u16(entry + 2)) == 3 && (try u32(entry + 4)) == 1, "malformed EXIF orientation")
                let value = try u16(entry + 8)
                try require(value >= 1 && value <= 8, "unsupported EXIF orientation"); try require(declared == nil, "duplicate EXIF orientation"); declared = UInt32(value); seen = true
            }
        }
    }
    if format == "public.jpeg" {
        try require(bytes.count >= 2 && bytes[0] == 255 && bytes[1] == 216, "invalid JPEG header")
        var p = 2
        while p < bytes.count {
            try require(bytes[p] == 255, "malformed JPEG marker")
            while p < bytes.count && bytes[p] == 255 { p += 1 }
            try require(p < bytes.count, "malformed JPEG marker")
            let marker = bytes[p]; p += 1
            if marker == 218 || marker == 217 { break }
            if marker == 1 || (marker >= 208 && marker <= 215) { continue }
            try require(p + 2 <= bytes.count, "malformed JPEG length")
            let length = Int(bytes[p]) << 8 | Int(bytes[p+1])
            try require(length >= 2 && p + length <= bytes.count, "malformed JPEG segment")
            if marker == 225 && length >= 8 && Array(bytes[(p+2)..<(p+8)]) == [69,120,105,102,0,0] { try tiff(p + 8, p + length) }
            p += length
        }
    } else {
        try require(bytes.count >= 8 && Array(bytes[0..<8]) == [137,80,78,71,13,10,26,10], "invalid PNG header")
        var p = 8
        while p < bytes.count {
            try require(p + 12 <= bytes.count, "malformed PNG chunk")
            let length = Int(bytes[p]) << 24 | Int(bytes[p+1]) << 16 | Int(bytes[p+2]) << 8 | Int(bytes[p+3])
            try require(length <= bytes.count - p - 12, "malformed PNG length")
            if Array(bytes[(p+4)..<(p+8)]) == [101,88,73,102] { try tiff(p + 8, p + 8 + length) }
            p += length + 12
        }
    }
    return declared
}
func image(_ frame: [String: Any]) throws -> ([[String: Any]], Int, Int) {
    try require(Set(frame.keys) == Set(["file", "hash"]), "unknown image fields")
    guard let file = frame["file"] as? String, file.hasPrefix("/"), let hash = frame["hash"] as? String else { throw Failure.invalid("invalid image pin") }
    let data = try boundedImage(file, hash)
    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw Failure.invalid("invalid image metadata") }
    guard let type = CGImageSourceGetType(source) else { throw Failure.invalid("unknown image format") }
    let format = type as String
    try require((format == "public.jpeg" || format == "public.png") && CGImageSourceGetCount(source) == 1, "unsupported visual image format; use a reviewed single-frame JPEG/PNG original")
    let declaredOrientation = try validateOrientation(data, format: format)
    try require(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, "image exceeds 4MP")
    guard let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.invalid("image decode failed") }
    try require(decoded.width == width && decoded.height == height, "decoded image dimensions differ from bounded metadata")
    // Missing EXIF orientation means upright; unknown/malformed values must not silently become upright.
    let rawOrientation = properties[kCGImagePropertyOrientation]
    let orientationValue: UInt32
    if let declaredOrientation = declaredOrientation { orientationValue = declaredOrientation } else if let rawOrientation = rawOrientation {
        guard let number = rawOrientation as? NSNumber, number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= 1, number.doubleValue <= 8 else { throw Failure.invalid("unsupported EXIF orientation") }
        orientationValue = number.uint32Value
    } else { orientationValue = 1 }
    guard let orientation = CGImagePropertyOrientation(rawValue: orientationValue) else { throw Failure.invalid("unsupported EXIF orientation") }
    let r = request(); try VNImageRequestHandler(cgImage: decoded, orientation: orientation, options: [:]).perform([r])
    guard let observations = r.results, !observations.isEmpty else { throw Failure.invalid("classification absent") }
    try require(observations.count <= 2048, "classification rows exceed limit; refusing truncation")
    let ids = Set(try r.supportedIdentifiers()); var seen = Set<String>()
    let rows = try observations.sorted { Array($0.identifier.utf8).lexicographicallyPrecedes(Array($1.identifier.utf8)) }.map { observation -> [String: Any] in
        try require(ids.contains(observation.identifier) && seen.insert(observation.identifier).inserted && observation.confidence.isFinite && observation.confidence >= 0 && observation.confidence <= 1, "invalid classification result")
        return ["identifier": observation.identifier, "score": observation.confidence]
    }
    return (rows, width, height)
}
do {
    let bytes = FileHandle.standardInput.readData(ofLength: 65537)
    try require(bytes.count <= 65536, "stdin exceeds 64 KiB")
    try require(FileHandle.standardInput.readData(ofLength: 1).isEmpty, "stdin exceeds bound")
    guard let input = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], input["version"] as? Int == 1, let operation = input["operation"] as? String else { throw Failure.invalid("invalid protocol") }
    let identity = try runtime()
    if operation == "probe" {
        try require(Set(input.keys) == Set(["version", "operation"]), "unknown probe fields")
        try emit(identity)
    } else {
        try require(operation == "classify" && Set(input.keys) == Set(["version", "operation", "key", "revision", "frames"]), "unknown operation/fields")
        guard let key = input["key"] as? String, key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, input["revision"] as? Int == 2, let frames = input["frames"] as? [[String: Any]] else { throw Failure.invalid("invalid settings") }
        try require(!frames.isEmpty && frames.count <= 32, "invalid frame count")
        var results = [[String: Any]]()
        for frame in frames {
            let (observations, width, height) = try image(frame)
            results.append(["hash": frame["hash"]!, "width": width, "height": height, "observations": observations])
        }
        try emit(["version": 1, "key": key, "runtime": identity, "frames": results])
    }
} catch {
    FileHandle.standardError.write(Data("Offline native category retrieval failed: \(error)\n".utf8))
    exit(1)
}
