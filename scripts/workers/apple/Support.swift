import Foundation
import CryptoKit

struct NativeFailure: Error {
    let state: String
    let code: String
    let message: String
    let action: String?
    init(_ message: String, state: String = "unknown", code: String = "NATIVE_FAILURE", action: String? = nil) {
        self.message = message; self.state = state; self.code = code; self.action = action
    }
}
func requireNative(_ condition: Bool, _ message: String) throws {
    if !condition { throw NativeFailure(message, code: "VALIDATION") }
}
func nativeInput() throws -> [String: Any] {
    let data = FileHandle.standardInput.readData(ofLength: 16 * 1024 * 1024 + 1)
    try requireNative(data.count <= 16 * 1024 * 1024, "Request exceeds 16 MiB")
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object["version"] as? Int == 1,
          let operation = object["operation"] as? String, ["probe", "prepare", "run"].contains(operation), object["id"] is String,
          Set(object.keys).isSubset(of: ["version", "id", "operation", "payload"])
    else { throw NativeFailure("Invalid worker request", code: "VALIDATION") }
    return object
}
func payload(_ request: [String: Any]) -> [String: Any] { request["payload"] as? [String: Any] ?? [:] }
func textField(_ object: [String: Any], _ name: String, maximum: Int = 200000) throws -> String {
    guard let value = object[name] as? String, !value.isEmpty, value.count <= maximum else { throw NativeFailure("Invalid \(name)", code: "VALIDATION") }
    return value
}
func checkedFile(_ file: String, maximum: Int = 512 * 1024 * 1024) throws -> URL {
    try requireNative(file.hasPrefix("/"), "Absolute input path required")
    let url = URL(fileURLWithPath: file)
    let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    try requireNative(info.isRegularFile == true && info.isSymbolicLink != true && (info.fileSize ?? Int.max) <= maximum, "Input must be a bounded regular file")
    return url
}
func nativeReply(_ id: String, _ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: ["version": 1, "id": id, "ok": true, "result": value], options: [.sortedKeys])
    try requireNative(data.count <= 16 * 1024 * 1024, "Response exceeds 16 MiB")
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func nativeError(_ id: String, _ error: Error) {
    let failure = error as? NativeFailure ?? NativeFailure(String(describing: error))
    var issue: [String: Any] = ["state": failure.state, "code": failure.code, "message": String(failure.message.prefix(2000))]
    if let action = failure.action { issue["userAction"] = action }
    let data = try! JSONSerialization.data(withJSONObject: ["version": 1, "id": id, "ok": false, "issue": issue], options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(1)
}
func languageMatches(_ language: String, _ available: String) -> Bool {
    Locale.Language(identifier: language).isEquivalent(to: Locale.Language(identifier: available))
}
func nativeProbe(_ operations: [String], languages: [String] = [], installed: [String]? = nil, details: [String: Any] = [:]) -> [String: Any] {
    ["operations": operations, "languages": languages.sorted(), "installedLanguages": (installed ?? languages).sorted(), "details": details]
}
func nativeMain(_ body: ([String: Any]) async throws -> [String: Any]) async {
    var id = "invalid"
    do { let request = try nativeInput(); id = request["id"] as! String; try nativeReply(id, try await body(request)) }
    catch { nativeError(id, error) }
}

func validateOrientation(_ data: Data, format: String) throws -> UInt32? {
    var declared: UInt32? = nil
    let bytes = [UInt8](data)
    func tiff(_ start: Int, _ end: Int) throws {
        try requireNative(start >= 0 && start + 8 <= end && end <= bytes.count, "malformed EXIF header")
        let little = bytes[start] == 73 && bytes[start + 1] == 73
        try requireNative(little || (bytes[start] == 77 && bytes[start + 1] == 77), "malformed EXIF byte order")
        func u16(_ p: Int) throws -> Int { try requireNative(p >= start && p + 2 <= end, "malformed EXIF offset"); return little ? Int(bytes[p]) | Int(bytes[p+1]) << 8 : Int(bytes[p]) << 8 | Int(bytes[p+1]) }
        func u32(_ p: Int) throws -> Int { try requireNative(p >= start && p + 4 <= end, "malformed EXIF offset"); return little ? Int(bytes[p]) | Int(bytes[p+1]) << 8 | Int(bytes[p+2]) << 16 | Int(bytes[p+3]) << 24 : Int(bytes[p]) << 24 | Int(bytes[p+1]) << 16 | Int(bytes[p+2]) << 8 | Int(bytes[p+3]) }
        try requireNative(try u16(start + 2) == 42, "malformed EXIF TIFF marker")
        let offset = try u32(start + 4); if offset == 0 { return }
        let ifd = start + offset, count = try u16(ifd)
        try requireNative(count <= 4096 && ifd + 2 + count * 12 + 4 <= end, "malformed EXIF directory")
        var seen = false
        for i in 0..<count {
            let entry = ifd + 2 + i * 12
            if try u16(entry) == 0x112 {
                try requireNative(!seen && (try u16(entry + 2)) == 3 && (try u32(entry + 4)) == 1, "malformed EXIF orientation")
                let value = try u16(entry + 8)
                try requireNative(value >= 1 && value <= 8, "unsupported EXIF orientation"); try requireNative(declared == nil, "duplicate EXIF orientation"); declared = UInt32(value); seen = true
            }
        }
    }
    if format == "public.jpeg" {
        try requireNative(bytes.count >= 2 && bytes[0] == 255 && bytes[1] == 216, "invalid JPEG header")
        var p = 2
        while p < bytes.count {
            try requireNative(bytes[p] == 255, "malformed JPEG marker")
            while p < bytes.count && bytes[p] == 255 { p += 1 }
            try requireNative(p < bytes.count, "malformed JPEG marker")
            let marker = bytes[p]; p += 1
            if marker == 218 || marker == 217 { break }
            if marker == 1 || (marker >= 208 && marker <= 215) { continue }
            try requireNative(p + 2 <= bytes.count, "malformed JPEG length")
            let length = Int(bytes[p]) << 8 | Int(bytes[p+1])
            try requireNative(length >= 2 && p + length <= bytes.count, "malformed JPEG segment")
            if marker == 225 && length >= 8 && Array(bytes[(p+2)..<(p+8)]) == [69,120,105,102,0,0] { try tiff(p + 8, p + length) }
            p += length
        }
    } else {
        try requireNative(bytes.count >= 8 && Array(bytes[0..<8]) == [137,80,78,71,13,10,26,10], "invalid PNG header")
        var p = 8
        while p < bytes.count {
            try requireNative(p + 12 <= bytes.count, "malformed PNG chunk")
            let length = Int(bytes[p]) << 24 | Int(bytes[p+1]) << 16 | Int(bytes[p+2]) << 8 | Int(bytes[p+3])
            try requireNative(length <= bytes.count - p - 12, "malformed PNG length")
            if Array(bytes[(p+4)..<(p+8)]) == [101,88,73,102] { try tiff(p + 8, p + 8 + length) }
            p += length + 12
        }
    }
    return declared
}
