// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import XCTest
@testable import T3Code

@MainActor
final class FeatureLinkRequestTests: XCTestCase {
    func testLocalPendingPermissionAndDuplicateGuard() async throws {
        let client = LinkAnswerClient()
        let controller = FeatureLinkRequestController()
        for permission: Bool? in [false, nil] {
            controller.code = "sensitive"
            XCTAssertNil(controller.submit(.decline, item: try request(), context: .init(threadID: "scoped", client: client, saved: [], canAnswer: permission)))
            XCTAssertEqual(controller.code, "")
        }
        let context = FeatureLinkRequestContext(threadID: "scoped", client: client, saved: [], canAnswer: true)
        for visibility in ["inherited", "synthetic"] {
            XCTAssertNil(controller.submit(.decline, item: try request(visibility: visibility), context: context))
        }
        for status in ["linked", "declined", "cancelled", "failed"] {
            XCTAssertNil(controller.submit(.decline, item: try request(status: status), context: context))
        }
        let task = try XCTUnwrap(controller.submit(.link(environmentID: "target", label: "Metal", urls: ["http://metal.tail370e39.ts.net:3773"], access: .fullAccess, pairingCode: "sensitive"), item: try request(), context: context))
        XCTAssertNil(controller.submit(.decline, item: try request(), context: context))
        await task.value
        XCTAssertEqual(client.calls.count, 1)
        XCTAssertEqual(client.calls.first?["access"]?.stringValue, "full-access")
        XCTAssertEqual(client.calls.first?["type"]?.stringValue, "link")
        XCTAssertEqual(controller.code, "")
        XCTAssertTrue(controller.submitted)
    }
    func testDismissIgnoresStaleCompletionAndErrorsAreRedacted() async throws {
        let client = LinkAnswerClient()
        let controller = FeatureLinkRequestController()
        let context = FeatureLinkRequestContext(threadID: "scoped", client: client, saved: [], canAnswer: true)
        let task = try XCTUnwrap(controller.submit(.decline, item: try request(), context: context))
        controller.clear()
        await task.value
        XCTAssertFalse(controller.submitted)
        XCTAssertTrue(client.calls.isEmpty)
        XCTAssertFalse(LinkRequestSafeError(RPCError.remote("sensitive")).localizedDescription.contains("sensitive"))
        XCTAssertEqual(LinkRequestAnswer.useExisting("target").payload, .object(["type": .string("use-existing"), "environmentId": .string("target")]))
    }
    private func request(status: String = "pending", visibility: String = "local") throws -> FeatureV2WorkItem {
        let raw = V2Fixture.item("link", type: "link_request", ordinal: 1, fields: ["reason": .string("Work there"), "linkStatus": .string(status)])
        let item = try OrchestrationV2TurnItem(json: raw)
        let row = OrchestrationV2ProjectedTurnItem(position: 0, visibility: visibility, sourceThreadId: "thread", sourceItemId: "link", item: item)
        let result = FeatureV2WorkItem(source: .init(row), raw: raw)
        XCTAssertTrue(result.isStandaloneContent)
        XCTAssertEqual(result.source.sourceThreadID, "thread")
        return result
    }
}
@MainActor
private final class LinkAnswerClient: FeatureLinkRequestAnswering {
    var calls: [JSONValue] = []
    func linkRequestMachines(threadID: String, saved: [FeatureEnvironment]) async throws -> [LinkRequestMachine] { [] }
    func answerLinkRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: LinkRequestAnswer) async throws { calls.append(answer.payload) }
}
