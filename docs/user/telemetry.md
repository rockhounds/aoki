# Product usage data and diagnostics

Aoki ships without a product analytics destination. If you configure one, product events contain usage metadata. An [agent feedback](#agent-feedback) report can include conversation text when you select it on the approval card.

## Product usage events

Set both `AOKI_TELEMETRY_HOST` and `AOKI_TELEMETRY_KEY` on the server to send usage events to your configured endpoint. Events can include a hashed random installation ID, a hashed T3 Connect account ID when signed in, and random client device IDs. They can also include the provider, catalog model name, reasoning effort, permission mode, outcome, duration, release channel, and token counts. Non-catalog models are reported as custom.

## Disable telemetry

- **Server / CLI**: Set `AOKI_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` before starting (`DO_NOT_TRACK=1` takes precedence). CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`) disable telemetry by default unless `AOKI_TELEMETRY_ENABLED=true`.
- **Desktop app**: Export `AOKI_TELEMETRY_ENABLED=false` or `DO_NOT_TRACK=1` in your shell profile (macOS/Linux) or user environment variables (Windows) and restart.
- **Managed policy**: Administrators can set `"telemetry": false` in [managed policy](./managed-policy.md#other-capabilities) for servers and desktop apps.
- **Mobile app**: Toggle **Send crash reports** and **Send connection traces** separately in **Settings → About Aoki → Diagnostics**.

## Relay connection diagnostics

A build with relay tracing configured can send connection timings, request paths, environment and thread IDs, and error types to its tracing endpoint. The server and desktop honor the opt-outs above and `AOKI_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED`. React Native mobile has its own diagnostics switches.

## Agent feedback

Optional tool for agents to report Aoki bugs or missing capabilities through your configured analytics endpoint. Configure in **Settings → Labs → Agent feedback**:

- **Off** (default): Feedback tools and `aoki feedback` are disabled.
- **When I ask**: Agents submit a report only when you ask, shown as an interactive approval card before anything leaves your machine.
- **Automatic**: Also sends minimal automated reports (problem kind + tool/command name only—no text or conversation) when an agent hits a T3 tool failure; enables `aoki feedback` CLI reporting (up to 10/hour).

Approval cards show exact payloads (expected/actual/workaround, turn outline with no text, and optional **Include the conversation** up to 16 KB). File paths, usernames, hostnames, git remotes, and secret-like strings are scrubbed before saving, and reports use one-off random IDs. Inspect local reports with `aoki feedback list [--json]`.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the T3 Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`AOKI_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `AOKI_OTLP_HEADERS` / `AOKI_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
