import Foundation
import Vision
import ImageIO
import CoreVideo

func visionImage(_ file: String) throws -> (CGImage, CGImagePropertyOrientation, Int, Int) {
    let url = try checkedFile(file, maximum: 16 * 1024 * 1024)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) == 1,
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int else { throw NativeFailure("Invalid single-frame image", code: "VALIDATION") }
    try requireNative(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, "Image exceeds 4 MP")
    guard let format = CGImageSourceGetType(source) as String?, ["public.jpeg", "public.png"].contains(format) else { throw NativeFailure("Use a single-frame JPEG or PNG", code: "VALIDATION") }
    let declared = try validateOrientation(Data(contentsOf: url), format: format)
    let raw = declared ?? 1
    guard let orientation = CGImagePropertyOrientation(rawValue: raw) else { throw NativeFailure("Invalid image orientation", code: "VALIDATION") }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw NativeFailure("Image decoding failed", code: "VALIDATION") }
    return (image, orientation, raw >= 5 ? height : width, raw >= 5 ? width : height)
}
func visionBox(_ observation: VNDetectedObjectObservation) -> [String: Any] {
    let b = observation.boundingBox
    return ["x": max(0, b.minX), "y": max(0, 1 - b.maxY), "w": min(1 - max(0, b.minX), b.width), "h": min(1 - max(0, 1 - b.maxY), b.height), "score": observation.confidence]
}
@main struct VisionWorker {
    static func main() async { await nativeMain { request in
        var operations = ["vision.faces", "vision.people", "vision.pose", "vision.saliency", "vision.flow", "vision.tracking"]
        #if compiler(>=6.0)
        if #available(macOS 15, *) { operations.append("vision.quality") }
        #endif
        if request["operation"] as? String != "run" { return nativeProbe(operations, details: ["coordinates": "normalised-top-left", "flowFormat": "float32le-xy"]) }
        let p = payload(request)
        guard let frames = p["frames"] as? [[String: Any]], !frames.isEmpty, frames.count <= 32,
              let features = p["features"] as? [String], !features.isEmpty, features.allSatisfy({ operations.contains("vision." + $0) }) else { throw NativeFailure("Invalid bounded frames/features", code: "VALIDATION") }
        var rows: [[String: Any]] = [], previous: (CGImage, CGImagePropertyOrientation)?
        let sequence = VNSequenceRequestHandler(); var trackers: [(String, VNTrackObjectRequest)] = []
        for (index, frame) in frames.enumerated() {
            let (image, orientation, width, height) = try visionImage(textField(frame, "file"))
            let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
            var row: [String: Any] = ["id": try textField(frame, "id", maximum: 128), "width": width, "height": height]
            var subjects: [VNDetectedObjectObservation] = []
            if features.contains("faces") || features.contains("tracking") {
                let r = VNDetectFaceRectanglesRequest(); try handler.perform([r]); let faces = r.results ?? []
                row["faces"] = faces.map(visionBox); subjects.append(contentsOf: faces)
            }
            if features.contains("people") || features.contains("tracking") {
                let r = VNDetectHumanRectanglesRequest(); r.upperBodyOnly = false; try handler.perform([r]); let people = r.results ?? []
                row["people"] = people.map(visionBox); if subjects.isEmpty { subjects.append(contentsOf: people) }
            }
            if features.contains("pose") {
                let r = VNDetectHumanBodyPoseRequest(); try handler.perform([r])
                row["poses"] = try (r.results ?? []).map { observation -> [String: Any] in
                    let points = try observation.recognizedPoints(.all)
                    return ["confidence": observation.confidence, "points": points.map { key, point in ["name": key.rawValue.rawValue, "x": point.location.x, "y": 1 - point.location.y, "score": point.confidence] as [String: Any] }]
                }
            }
            if features.contains("saliency") {
                let r = VNGenerateAttentionBasedSaliencyImageRequest(); try handler.perform([r]); row["saliency"] = (r.results?.first?.salientObjects ?? []).map(visionBox)
            }
            #if compiler(>=6.0)
            if features.contains("quality") {
                if #available(macOS 15, *) {
                    let r = VNCalculateImageAestheticsScoresRequest(); try handler.perform([r])
                    if let score = r.results?.first { row["quality"] = ["overallScore": score.overallScore, "isUtility": score.isUtility] }
                }
            }
            #endif
            if features.contains("tracking") {
                if index == 0 { trackers = subjects.enumerated().map { ("track-\($0.offset)", VNTrackObjectRequest(detectedObjectObservation: $0.element)) } }
                else { try sequence.perform(trackers.map { $0.1 }, on: image, orientation: orientation) }
                row["tracks"] = trackers.compactMap { id, r -> [String: Any]? in
                    guard let found = (r.results?.first as? VNDetectedObjectObservation) ?? (index == 0 ? r.inputObservation : nil) else { return nil }
                    r.inputObservation = found; var b = visionBox(found); b["id"] = id; return b
                }
            }
            if features.contains("flow"), let prior = previous {
                let r = VNGenerateOpticalFlowRequest(targetedCGImage: prior.0, orientation: prior.1, options: [:]); r.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
                try handler.perform([r])
                if let buffer = r.results?.first?.pixelBuffer {
                    let output = try textField(frame, "flowOutput")
                    try requireNative(output.hasPrefix("/") && !FileManager.default.fileExists(atPath: output), "Flow output must be new and absolute")
                    CVPixelBufferLockBaseAddress(buffer, .readOnly); defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
                    let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
                    var data = Data(); guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw NativeFailure("Flow buffer unavailable") }
                    for y in 0..<h { data.append(base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self), count: w * 8) }
                    try data.write(to: URL(fileURLWithPath: output), options: .withoutOverwriting)
                    row["flow"] = ["file": output, "width": w, "height": h, "format": "float32le-xy", "direction": "current-to-previous", "previousId": frames[index - 1]["id"]!]
                }
            }
            rows.append(row); previous = (image, orientation)
        }
        return ["frames": rows, "coordinates": "normalised-top-left", "advisory": true]
    } }
}
