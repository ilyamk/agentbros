import Foundation
#if canImport(Translation) && compiler(>=6.2)
import Translation
#endif

@main struct TranslationWorker {
    static func main() async { await nativeMain { request in
        #if canImport(Translation) && compiler(>=6.2)
        if #available(macOS 26, *) { return try await perform(request) }
        #endif
        throw NativeFailure("Headless Translation needs macOS 26 or later", state: "unsupported", code: "OS_UNSUPPORTED")
    } }
    #if canImport(Translation) && compiler(>=6.2)
    @available(macOS 26, *) static func perform(_ request: [String: Any]) async throws -> [String: Any] {
        let p = payload(request), availability = LanguageAvailability()
        let languages = await availability.supportedLanguages.map { $0.minimalIdentifier }
        let source = p["language"] as? String, target = p["targetLanguage"] as? String
        if source == nil || target == nil { return nativeProbe(["text.translate"], languages: languages, installed: [], details: ["pairCheckRequired": true]) }
        let from = Locale.Language(identifier: source!), to = Locale.Language(identifier: target!)
        let status = await availability.status(from: from, to: to)
        if status == .unsupported { throw NativeFailure("Unsupported translation pair", state: "unsupported", code: "LANGUAGE_UNSUPPORTED") }
        if status != .installed {
            throw NativeFailure("Translation languages are not installed; headless sessions cannot download them", state: "needs_user_action", code: "LANGUAGES_NOT_INSTALLED", action: "Open System Settings > General > Language & Region > Translation Languages and download the requested languages, then refresh capabilities.")
        }
        if request["operation"] as? String != "run" { return nativeProbe(["text.translate"], languages: [source!, target!], details: ["pairInstalled": true]) }
        let session = TranslationSession(installedSource: from, target: to)
        guard let units = p["units"] as? [[String: Any]], !units.isEmpty, units.count <= 1000 else { throw NativeFailure("Invalid translation units", code: "VALIDATION") }
        var output: [[String: Any]] = []
        for unit in units {
            let id = try textField(unit, "id", maximum: 128), text = unit["text"] as? String ?? ""
            try requireNative(text.count <= 200000, "Translation unit exceeds bound")
            let translated = text.isEmpty ? "" : try await session.translate(text).targetText
            output.append(["id": id, "text": translated])
        }
        return ["units": output, "sourceLanguage": source!, "targetLanguage": target!]
    }
    #endif
}
