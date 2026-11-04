// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import SwiftUI

struct LinkRequestMachine: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let urls: [String]
    var access: LinkAccess?
}
@MainActor
protocol FeatureLinkRequestAnswering: AnyObject {
    func linkRequestMachines(threadID: String, saved: [FeatureEnvironment]) async throws -> [LinkRequestMachine]
    func answerLinkRequest(threadID: String, source: OrchestrationV2TimelineMetadata, answer: LinkRequestAnswer) async throws
}
@MainActor
struct FeatureLinkRequestContext {
    let threadID: String
    let client: any FeatureLinkRequestAnswering
    let saved: [FeatureEnvironment]
    let canAnswer: Bool?
}
@MainActor
final class FeatureLinkRequestController: ObservableObject {
    @Published var code = ""
    @Published private(set) var sending = false
    @Published private(set) var submitted = false
    @Published private(set) var error: String?
    private var generation = 0
    func clear() { generation += 1; code = ""; sending = false; submitted = false; error = nil }
    @discardableResult
    func submit(_ answer: LinkRequestAnswer, item: FeatureV2WorkItem, context: FeatureLinkRequestContext) -> Task<Void, Never>? {
        if context.canAnswer != true { clear(); return nil }
        guard context.canAnswer == true, item.source.visibility == "local",
              item.raw["linkStatus"]?.stringValue == "pending", !sending, !submitted else { return nil }
        sending = true
        error = nil
        let current = generation
        return Task { [weak self] in
            guard self?.generation == current else { return }
            do {
                try await context.client.answerLinkRequest(threadID: context.threadID, source: item.source, answer: answer)
                guard let self, generation == current else { return }
                code = ""; sending = false; submitted = true
            } catch {
                guard let self, generation == current else { return }
                code = ""; sending = false
                self.error = LinkRequestSafeError(error).localizedDescription
            }
        }
    }
}
struct FeatureLinkRequestCard: View {
    let item: FeatureV2WorkItem
    let context: FeatureLinkRequestContext?
    @StateObject private var controller = FeatureLinkRequestController()
    @State private var machines: [LinkRequestMachine] = []
    @State private var selected = ""
    @State private var address = ""
    @State private var access: LinkAccess = .approvalRequired
    @State private var loadError: String?
    private var machine: LinkRequestMachine? { machines.first { $0.id == selected } }
    private var pending: Bool { item.raw["linkStatus"]?.stringValue == "pending" }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(item.raw["label"]?.stringValue ?? "Connect a machine", systemImage: "network")
            if let hint = item.raw["hint"]?.stringValue { Text(hint) }
            if let reason = item.raw["reason"]?.stringValue { Text(reason) }
            if let url = item.raw["url"]?.stringValue { Text(url) }
            if !pending {
                Text((item.raw["linkStatus"]?.stringValue ?? "ended").capitalized)
                if let label = item.raw["linkedLabel"]?.stringValue { Text(label) }
                if let grant = item.raw["linkedAccess"]?.stringValue { Text("Access: \(grant)") }
                if item.raw["linkStatus"]?.stringValue == "failed" { Text("Connection failed. Ask for a new request and check the address and pairing code.") }
            } else if item.source.visibility != "local" {
                Text("Answer in the original thread (\(item.source.sourceThreadID)). This inherited or synthetic request is read only.")
            } else if let context, context.canAnswer == true {
                if controller.submitted { Text("Answer sent") }
                else {
                    Picker("Machine", selection: $selected) {
                        Text("Manual address").tag("")
                        ForEach(machines) { Text($0.label).tag($0.id) }
                    }
                    if let machine {
                        Text(machine.urls.first ?? "No saved address")
                        if let grant = machine.access {
                            Text("Current grant: \(grant.label)")
                            Button("Use current grant (\(grant.label))") {
                                controller.submit(.useExisting(machine.id), item: item, context: context)
                            }.disabled(controller.sending)
                        }
                    } else {
                        TextField("http://machine:3773", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Picker("Access", selection: $access) {
                        ForEach(LinkAccess.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Text("To link or renew with the selected access, paste a fresh pairing code from that machine’s Connections settings or t3 pair.")
                    SecureField("Pairing code", text: $controller.code)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    HStack(spacing: 20) {
                        Button("Link with selected access") {
                            let urls = machine?.urls ?? [address.trimmingCharacters(in: .whitespacesAndNewlines)]
                            controller.submit(.link(environmentID: machine?.id, label: machine?.label,
                                urls: urls, access: access, pairingCode: controller.code.trimmingCharacters(in: .whitespacesAndNewlines)), item: item, context: context)
                        }.disabled(controller.sending || controller.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (machine?.urls.first ?? address).isEmpty)
                        Button("Decline") { controller.submit(.decline, item: item, context: context) }.disabled(controller.sending)
                    }
                    if let error = controller.error { Text(error).foregroundStyle(T3Colors.danger) }
                    if let loadError { Text(loadError).foregroundStyle(T3Colors.danger) }
                }
            } else { Text("Connection management permission is required to answer.") }
        }
        .disabled(controller.sending)
        .font(T3Typography.supporting)
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: context?.canAnswer) {
            guard let context, context.canAnswer == true, pending, item.source.visibility == "local" else { controller.clear(); return }
            access = item.raw["requestedAccess"]?.stringValue.flatMap(LinkAccess.init(rawValue:)) ?? .approvalRequired
            address = item.raw["url"]?.stringValue ?? ""
            do {
                machines = try await context.client.linkRequestMachines(threadID: context.threadID, saved: context.saved)
                guard !Task.isCancelled else { return }
                selected = machines.first { $0.id == item.raw["environmentId"]?.stringValue || $0.label == item.raw["label"]?.stringValue }?.id ?? ""
            } catch { loadError = LinkRequestSafeError(error).localizedDescription }
        }
        .onChange(of: item.raw["linkStatus"]) { _, _ in controller.clear() }
        .onChange(of: context?.canAnswer) { _, value in if value != true { controller.clear() } }
        .onChange(of: selected) { _, _ in controller.code = "" }
        .onDisappear { controller.clear() }
    }
}
