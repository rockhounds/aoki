// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import Foundation

public enum LinkAccess: String, Codable, CaseIterable, Sendable {
    case readOnly = "read-only", approvalRequired = "approval-required", autoAcceptEdits = "auto-accept-edits", auto, fullAccess = "full-access"
    public var label: String {
        switch self {
        case .readOnly: "Read only"
        case .approvalRequired: "Require approval"
        case .autoAcceptEdits: "Accept edits"
        case .auto: "Auto"
        case .fullAccess: "Full access"
        }
    }
}
public struct OrchestrationV2LinkRequest: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case pending, linked, declined, cancelled, failed }
    public let reason: String
    public let url: String?
    public let environmentId: String?
    public let label: String?
    public let hint: String?
    public let requestedAccess: LinkAccess?
    public let linkStatus: Status
    public let linkedEnvironmentId: String?
    public let linkedLabel: String?
    public let linkedAccess: LinkAccess?
    public let failure: JSONValue?
}
public enum LinkRequestAnswer: Sendable {
    case decline
    case useExisting(String)
    case link(environmentID: String?, label: String?, urls: [String], access: LinkAccess, pairingCode: String)
    var payload: JSONValue {
        switch self {
        case .decline: .object(["type": .string("decline")])
        case let .useExisting(id): .object(["type": .string("use-existing"), "environmentId": .string(id)])
        case let .link(id, label, urls, access, code):
            .object(["type": .string("link"), "environmentId": id.map(JSONValue.string),
                     "label": label.map(JSONValue.string), "urls": .array(urls.map(JSONValue.string)),
                     "access": .string(access.rawValue), "pairingCode": .string(code)].compactMapValues { $0 })
        }
    }
}
struct LinkRequestSafeError: LocalizedError, Sendable {
    let errorDescription: String?
    init(_ error: any Error) {
        errorDescription = error is EnvironmentPermissionDeniedError
            ? "You do not have permission to manage connections."
            : "Could not answer the connection request. Refresh its status before trying again. The server may need an update."
    }
}
extension T3Client {
    public func answerLinkRequest(threadID: String, turnItemID: String, answer: LinkRequestAnswer) async throws {
        do {
            if case let .link(_, _, urls, _, code) = answer {
                guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !urls.isEmpty,
                      urls.allSatisfy({ value in
                          guard let url = URLComponents(string: value) else { return false }
                          return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
                              && url.user == nil && url.password == nil && url.query == nil && url.fragment == nil
                      }) else { throw RPCError.disconnected }
            }
            let latest = try await rpc.request("orchestration.getTurnItem", payload: .object([
                "threadId": .string(threadID), "itemId": .string(turnItemID),
            ]), as: JSONValue.self)
            guard latest["item"]?["type"]?.stringValue == "link_request",
                  latest["item"]?["threadId"]?.stringValue == threadID,
                  latest["item"]?["id"]?.stringValue == turnItemID,
                  latest["item"]?["linkStatus"]?.stringValue == "pending" else { throw RPCError.disconnected }
            try await rpc.request("peerLinks.answerRequest", payload: .object([
                "threadId": .string(threadID), "turnItemId": .string(turnItemID), "answer": answer.payload,
            ]))
        } catch { throw LinkRequestSafeError(error) }
    }
    func linkRequestPeers() async throws -> JSONValue {
        try await rpc.request("peerLinks.list", as: JSONValue.self)
    }
}
