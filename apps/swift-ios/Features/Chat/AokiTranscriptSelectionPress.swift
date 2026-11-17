// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT

import UIKit

/// One long press driving a text view's selection, as UIKit's own long press
/// on text does: select the word under the finger, extend by word while it
/// drags, show the loupe, then the edit menu on lift.
@MainActor
final class TranscriptSelectionPress {
    let messageID: String
    private(set) weak var textView: UITextView?
    private var anchor: UITextRange?
    private var loupe: UITextLoupeSession?

    init(messageID: String) {
        self.messageID = messageID
    }

    func start(in textView: UITextView, at point: CGPoint) {
        guard let position = textView.closestPosition(to: point), textView.becomeFirstResponder() else { return }
        self.textView = textView
        let anchor = word(at: position, in: textView) ?? textView.textRange(from: position, to: position)
        self.anchor = anchor
        textView.selectedTextRange = anchor
        loupe = UITextLoupeSession.begin(at: point, fromSelectionWidgetView: nil, in: textView)
    }

    func extend(to point: CGPoint) {
        guard let textView, let anchor, let position = textView.closestPosition(to: point) else { return }
        loupe?.move(to: point, withCaretRect: .null, trackingCaret: false)
        let word = word(at: position, in: textView)
        let range = if textView.compare(position, to: anchor.start) == .orderedAscending {
            textView.textRange(from: word?.start ?? position, to: anchor.end)
        } else {
            textView.textRange(from: anchor.start, to: later(word?.end ?? position, anchor.end, in: textView))
        }
        if let range { textView.selectedTextRange = range }
    }

    func finish(at point: CGPoint) {
        cancel()
        guard let textView, textView.selectedTextRange?.isEmpty == false else { return }
        textView.interactions.lazy.compactMap { $0 as? UIEditMenuInteraction }.first?
            .presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: point))
    }

    func cancel() {
        loupe?.invalidate()
        loupe = nil
    }

    private func word(at position: UITextPosition, in textView: UITextView) -> UITextRange? {
        textView.tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.forward))
            ?? textView.tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.backward))
    }

    private func later(_ lhs: UITextPosition, _ rhs: UITextPosition, in textView: UITextView) -> UITextPosition {
        textView.compare(lhs, to: rhs) == .orderedDescending ? lhs : rhs
    }
}
