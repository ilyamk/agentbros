import Foundation
import AVFoundation

@main struct TTSWorker {
    static func main() async { await nativeMain { request in
        let p = payload(request)
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { !$0.voiceTraits.contains(.isPersonalVoice) }
        if request["operation"] as? String != "run" {
            var probe = nativeProbe(["speech.synthesise"], languages: Array(Set(voices.map { $0.language })))
            probe["voices"] = voices.map { ["id": $0.identifier, "name": $0.name, "language": $0.language] }; return probe
        }
        let identifier = try textField(p, "voice", maximum: 500)
        guard let voice = voices.first(where: { $0.identifier == identifier }) else { throw NativeFailure("Requested installed voice unavailable", state: "needs_user_action", code: "VOICE_UNAVAILABLE", action: "Choose an installed voice or download it in macOS Accessibility > Spoken Content, then refresh capabilities.") }
        let text = try textField(p, "text"), output = try textField(p, "output")
        try requireNative(output.hasPrefix("/") && !FileManager.default.fileExists(atPath: output), "Output must be new and absolute")
        let utterance = AVSpeechUtterance(string: text); utterance.voice = voice
        let synthesiser = AVSpeechSynthesizer()
        var file: AVAudioFile?
        var storedError: Error?
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            synthesiser.write(utterance) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { continuation.resume(); return }
                do {
                    if file == nil { file = try AVAudioFile(forWriting: URL(fileURLWithPath: output), settings: pcm.format.settings) }
                    try file?.write(from: pcm)
                } catch { storedError = error }
            }
        }
        if let error = storedError { throw error }
        try requireNative(file != nil, "Synthesiser produced no audio")
        let frames = file!.length, sampleRate = file!.processingFormat.sampleRate
        return ["voice": identifier, "language": voice.language, "durationSec": Double(frames) / sampleRate, "sampleRate": sampleRate]
    } }
}
