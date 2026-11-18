import Foundation
import NaturalLanguage

@main struct TextWorker {
    static func main() async { await nativeMain { request in
        let p = payload(request)
        let languages = Locale.isoLanguageCodes.filter { $0.count == 2 }
        if request["operation"] as? String != "run" {
            var schemes: [String: Any] = [:]
            for language in languages { schemes[language] = NLTagger.availableTagSchemes(for: .word, language: NLLanguage(rawValue: language)).map { $0.rawValue } }
            return nativeProbe(["text.analyse"], languages: languages, details: ["schemes": schemes])
        }
        let text = try textField(p, "text")
        let language = p["language"] as? String
        let recogniser = NLLanguageRecognizer(); recogniser.processString(text)
        let dominant = recogniser.dominantLanguage?.rawValue ?? "und"
        let selected = NLLanguage(rawValue: language ?? dominant)
        let requested = p["operations"] as? [String] ?? ["language", "sentences", "tokens", "entities", "lemmas"]
        let available = NLTagger.availableTagSchemes(for: .word, language: selected)
        var rows: [[String: Any]] = []
        for (operation, scheme) in [("entities", NLTagScheme.nameType), ("lemmas", .lemma)] where requested.contains(operation) {
            if !available.contains(scheme) { throw NativeFailure("\(operation) unavailable for \(selected.rawValue)", state: "unsupported", code: "LANGUAGE_UNSUPPORTED") }
            let tagger = NLTagger(tagSchemes: [scheme]); tagger.string = text
            tagger.setLanguage(selected, range: text.startIndex..<text.endIndex)
            tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: scheme, options: [.omitWhitespace, .omitPunctuation, .joinNames]) { tag, range in
                if let tag = tag, scheme != .nameType || tag != .otherWord {
                    let span = NSRange(range, in: text)
                    rows.append(["operation": operation, "text": String(text[range]), "value": tag.rawValue, "startUtf16": span.location, "lengthUtf16": span.length])
                }
                return true
            }
        }
        for (operation, unit) in [("sentences", NLTokenUnit.sentence), ("tokens", .word)] where requested.contains(operation) {
            let tokenizer = NLTokenizer(unit: unit); tokenizer.string = text; tokenizer.setLanguage(selected)
            tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
                let span = NSRange(range, in: text)
                rows.append(["operation": operation, "text": String(text[range]), "value": String(text[range]), "startUtf16": span.location, "lengthUtf16": span.length]); return true
            }
        }
        return ["language": language ?? dominant, "hypotheses": recogniser.languageHypotheses(withMaximum: 3).reduce(into: [String: Double]()) { $0[$1.key.rawValue] = $1.value }, "items": rows]
    } }
}
