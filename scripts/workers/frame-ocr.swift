// Explicit preparation only: swiftc frame-ocr.swift -o /trusted/ignored/frame-ocr.
// Production accepts a prebuilt hash-pinned executable and never invokes Swift.
import Foundation
import Vision
import ImageIO
import CryptoKit

enum Failure: Error { case invalid(String) }
func require(_ value: Bool, _ message: String) throws { if !value { throw Failure.invalid(message) } }
func emit(_ object: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    try require(data.count <= 256 * 1024, "response exceeds 256 KiB")
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func request() -> VNRecognizeTextRequest {
    let r = VNRecognizeTextRequest()
    r.revision = VNRecognizeTextRequestRevision3
    r.recognitionLevel = .accurate
    r.usesLanguageCorrection = false
    r.automaticallyDetectsLanguage = false
    r.usesCPUOnly = true
    return r
}
func runtime() throws -> [String: Any] {
    return ["engine": "apple-vision", "revision": 3, "osVersion": ProcessInfo.processInfo.operatingSystemVersionString, "supportedLanguages": try request().supportedRecognitionLanguages().sorted()]
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
        try require(operation == "recognize" && Set(input.keys) == Set(["version", "operation", "key", "revision", "languages", "frames"]), "unknown operation/fields")
        guard let key = input["key"] as? String, key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, input["revision"] as? Int == 3, let languages = input["languages"] as? [String], let frames = input["frames"] as? [[String: Any]] else { throw Failure.invalid("invalid settings") }
        let supported = identity["supportedLanguages"] as! [String]
        try require(!languages.isEmpty && languages.count <= 4 && Set(languages).count == languages.count && languages.allSatisfy { supported.contains($0) }, "unsupported languages")
        try require(!frames.isEmpty && frames.count <= 32, "invalid frame count")
        var results = [[String: Any]]()
        // One process and one bounded batch; the host enforces a whole-batch deadline.
        for frame in frames {
            try require(Set(frame.keys) == Set(["file", "hash"]), "unknown frame fields")
            guard let file = frame["file"] as? String, file.hasPrefix("/"), let hash = frame["hash"] as? String else { throw Failure.invalid("invalid frame pin") }
            let url = URL(fileURLWithPath: file)
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            try require(values.isRegularFile == true && values.isSymbolicLink != true && (values.fileSize ?? Int.max) <= 16 * 1024 * 1024, "unsafe image file")
            let data = try Data(contentsOf: url)
            try require(data.count <= 16 * 1024 * 1024 && SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == hash, "image checksum mismatch")
            guard let source = CGImageSourceCreateWithData(data as CFData, nil), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any], let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw Failure.invalid("invalid image metadata") }
            try require(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, "image exceeds 4MP")
            guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.invalid("image decode failed") }
            let recognition = request(); recognition.recognitionLanguages = languages
            try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([recognition])
            let observations = recognition.results ?? []
            try require(observations.count <= 100, "too many observations")
            var rows = [[String: Any]]()
            for observation in observations {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                try require(text.count <= 2000, "text too long")
                let b = observation.boundingBox
                rows.append(["text": text, "confidence": candidate.confidence, "box": ["x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height]])
            }
            results.append(["hash": hash, "width": width, "height": height, "observations": rows])
        }
        try emit(["version": 1, "key": key, "runtime": identity, "frames": results])
    }
} catch {
    FileHandle.standardError.write(Data("Offline OCR failed: \(error)\n".utf8))
    exit(1)
}
