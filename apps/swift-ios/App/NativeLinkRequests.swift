// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import Foundation

extension NativeFeatureClient: FeatureLinkRequestAnswering {
    func linkRequestMachines(threadID: String, saved: [FeatureEnvironment]) async throws -> [LinkRequestMachine] {
        do {
            let context = try await v2ActionContext(threadID: threadID)
            try await requireScope("access:write", client: context.client)
            let peers = try await context.client.linkRequestPeers()
            let rows = peers.v2Array ?? peers["links"]?.v2Array ?? []
            var machines = saved.filter(\.isEnabled).map { environment in
                LinkRequestMachine(id: environment.id, label: environment.name,
                    urls: [environment.endpoint], access: nil)
            }
            for index in machines.indices {
                let routes = try await environmentRoutes(environmentID: machines[index].id)
                let ordered = routes.routes.sorted { $0.id == routes.activeRouteID && $1.id != routes.activeRouteID }
                machines[index] = LinkRequestMachine(id: machines[index].id, label: machines[index].label,
                    urls: ordered.isEmpty ? machines[index].urls : ordered.map { $0.httpBaseURL.absoluteString }, access: nil)
            }
            for row in rows {
                guard let id = row["environmentId"]?.stringValue else { continue }
                let grant = row["access"]?.stringValue.flatMap(LinkAccess.init(rawValue:))
                if let index = machines.firstIndex(where: { $0.id == id }) { machines[index].access = grant }
                else { machines.append(LinkRequestMachine(id: id, label: row["label"]?.stringValue ?? id,
                    urls: row["urls"]?.v2Array?.compactMap(\.stringValue) ?? [], access: grant)) }
            }
            return machines
        } catch { throw LinkRequestSafeError(error) }
    }
    func answerLinkRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: LinkRequestAnswer) async throws {
        do {
            let context = try await v2ActionContext(threadID: threadID)
            guard source.itemType == "link_request", source.visibility == "local", source.sourceThreadID == context.wireID else { throw RPCError.disconnected }
            try await requireScope("access:write", client: context.client)
            try await context.client.answerLinkRequest(threadID: context.wireID, turnItemID: source.itemID, answer: answer)
        } catch { throw LinkRequestSafeError(error) }
    }
}
