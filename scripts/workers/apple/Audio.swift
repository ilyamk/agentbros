import Foundation
import CryptoKit
import SoundAnalysis

final class AudioObserver: NSObject, SNResultsObserving {
    var events: [[String: Any]] = []
    var error: Error?
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let value = result as? SNClassificationResult else { return }
        for classification in value.classifications.prefix(5) {
            events.append(["label": classification.identifier, "score": classification.confidence, "startSec": CMTimeGetSeconds(value.timeRange.start), "endSec": CMTimeGetSeconds(CMTimeRangeGetEnd(value.timeRange))])
        }
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { self.error = error }
    func requestDidComplete(_ request: SNRequest) {}
}
@main struct AudioWorker {
    static func main() async { await nativeMain { request in
        let classifier = try SNClassifySoundRequest(classifierIdentifier: .version1)
        let labels = classifier.knownClassifications.sorted()
        if request["operation"] as? String != "run" {
            return nativeProbe(["audio.events"], details: ["labels": labels, "taxonomyHash": SHA256.hash(data: Data(labels.joined(separator: "\n").utf8)).map { String(format: "%02x", $0) }.joined()])
        }
        let p = payload(request), file = try checkedFile(textField(p, "file"))
        let analyser = try SNAudioFileAnalyzer(url: file), observer = AudioObserver()
        try analyser.add(classifier, withObserver: observer); analyser.analyze()
        if let error = observer.error { throw error }
        return ["events": observer.events, "windowSec": CMTimeGetSeconds(classifier.windowDuration), "overlap": classifier.overlapFactor, "labels": labels, "advisory": true]
    } }
}
