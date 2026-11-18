import Foundation
import AVFoundation
import NaturalLanguage
#if canImport(Speech)
import Speech
#endif

@main struct SpeechWorker {
    static func main() async { await nativeMain { request in
        #if canImport(Speech) && compiler(>=6.2)
        if #available(macOS 26, *) { return try await perform(request) }
        #endif
        throw NativeFailure("Apple SpeechTranscriber needs macOS 26 and a compatible SDK", state: "unsupported", code: "OS_UNSUPPORTED")
    } }
    #if canImport(Speech) && compiler(>=6.2)
    @available(macOS 26, *) static func perform(_ request: [String: Any]) async throws -> [String: Any] {
        guard SpeechTranscriber.isAvailable else { throw NativeFailure("SpeechTranscriber unavailable on this device", state: "unsupported", code: "DEVICE_UNSUPPORTED") }
        let p = payload(request)
        let languages = await SpeechTranscriber.supportedLocales.map { $0.identifier }
        let installed = await SpeechTranscriber.installedLocales.map { $0.identifier }
        guard let language = p["language"] as? String else { return nativeProbe(["speech.transcribe"], languages: languages, installed: installed, details: ["verbatim": false, "wordTimingRequiresResultValidation": true]) }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) else { throw NativeFailure("Apple Speech does not support \(language)", state: "unsupported", code: "LANGUAGE_UNSUPPORTED") }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange, .transcriptionConfidence])
        let status = await AssetInventory.status(forModules: [transcriber])
        if request["operation"] as? String == "prepare" {
            if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await installation.downloadAndInstall() }
            return nativeProbe(["speech.transcribe"], languages: languages, installed: await SpeechTranscriber.installedLocales.map { $0.identifier })
        }
        guard status == .installed else { throw NativeFailure("Speech model is \(status)", state: status == .downloading ? "temporarily_unavailable" : "needs_download", code: "MODEL_NOT_INSTALLED") }
        if request["operation"] as? String == "probe" { return nativeProbe(["speech.transcribe"], languages: languages, installed: installed, details: ["verbatim": false, "wordTimingRequiresResultValidation": true]) }
        let file = try AVAudioFile(forReading: checkedFile(try textField(p, "file")))
        let analyser = SpeechAnalyzer(modules: [transcriber])
        let results = Task { () throws -> ([[String: Any]], Bool) in
            var words: [[String: Any]] = [], estimated = false
            for try await result in transcriber.results {
                for run in result.text.runs {
                    let text = String(result.text[run.range].characters)
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                    let tokenizer = NLTokenizer(unit: .word); tokenizer.string = text
                    var pieces: [String] = []
                    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in pieces.append(String(text[range])); return true }
                    guard !pieces.isEmpty else { continue }
                    let nativeRange = run.audioTimeRange
                    let range = nativeRange ?? result.range
                    if pieces.count != 1 || nativeRange == nil { estimated = true }
                    let start = CMTimeGetSeconds(range.start), duration = CMTimeGetSeconds(range.duration)
                    for (i, piece) in pieces.enumerated() {
                        words.append(["text": pieces.count == 1 ? text.trimmingCharacters(in: .whitespacesAndNewlines) : piece,
                                      "startSec": start + duration * Double(i) / Double(pieces.count),
                                      "endSec": start + duration * Double(i + 1) / Double(pieces.count),
                                      "confidence": run.transcriptionConfidence.map { Double($0) } as Any? ?? NSNull()])
                    }
                }
            }
            return (words, estimated)
        }
        do {
            if let end = try await analyser.analyzeSequence(from: file) { try await analyser.finalizeAndFinish(through: end) }
            else { try await analyser.finalizeAndFinishThroughEndOfInput() }
            let (words, estimated) = try await results.value
            return ["language": locale.language.languageCode?.identifier ?? language, "timing": estimated ? "estimated" : "native", "verbatim": false, "words": words]
        } catch { results.cancel(); await analyser.cancelAndFinishNow(); throw error }
    }
    #endif
}
