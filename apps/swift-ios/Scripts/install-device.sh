#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEVICE_ID="${T3_SWIFT_DEVICE_ID:-${1:-}}"
DEVELOPMENT_TEAM="${T3_SWIFT_DEVELOPMENT_TEAM:-${2:-}}"
CONFIGURATION="${T3_SWIFT_CONFIGURATION:-Debug}"
DERIVED_DATA_PATH="${T3_SWIFT_DERIVED_DATA_PATH:-${APP_DIR}/.derivedData/device}"
MIN_PROFILE_TTL_HOURS="${T3_SWIFT_MIN_PROFILE_TTL_HOURS:-48}"
PROVISIONING_PROFILES_DIR="${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles"
EXPIRED_PROFILES_DIR="${HOME}/Library/Developer/Xcode/UserData/Provisioning Profiles.expired"

die() {
  printf '[swift-ios-device] error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd awk
require_cmd mktemp
require_cmd plutil
require_cmd python3
require_cmd security
require_cmd xcodebuild
require_cmd xcrun

[[ "${MIN_PROFILE_TTL_HOURS}" =~ ^[0-9]+$ ]] || die \
  "T3_SWIFT_MIN_PROFILE_TTL_HOURS must be a non-negative integer"
MIN_PROFILE_TTL_SECONDS="$((MIN_PROFILE_TTL_HOURS * 3600))"

[[ "${CONFIGURATION}" == "Debug" || "${CONFIGURATION}" == "Release" ]] || die \
  "T3_SWIFT_CONFIGURATION must be Debug or Release"

if [[ "${CONFIGURATION}" == "Debug" ]]; then
  BUNDLE_IDENTIFIER="io.github.rockhounds.aoki.native.dev"
else
  BUNDLE_IDENTIFIER="io.github.rockhounds.aoki.native"
fi
WIDGET_BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER}.widgets"
SHARE_BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER}.sharing"

[[ -z "${T3_SWIFT_BUNDLE_IDENTIFIER:-}" || "${T3_SWIFT_BUNDLE_IDENTIFIER}" == "${BUNDLE_IDENTIFIER}" ]] || die \
  "custom bundle identifiers are unsupported; select the Debug or Release identity with T3_SWIFT_CONFIGURATION"

bundle_identifier_for_target() {
  local target="$1"
  xcodebuild -showBuildSettings \
    -project "${APP_DIR}/T3Code.xcodeproj" \
    -target "${target}" \
    -configuration "${CONFIGURATION}" \
    | awk '$1 == "PRODUCT_BUNDLE_IDENTIFIER" && $2 == "=" { print $3; exit }'
}

verify_bundle_identifiers() {
  local host widgets share
  host="$(bundle_identifier_for_target T3Code)"
  widgets="$(bundle_identifier_for_target T3CodeWidgets)"
  share="$(bundle_identifier_for_target T3CodeShare)"
  [[ "${host}" == "${BUNDLE_IDENTIFIER}" ]] || die \
    "host bundle identifier resolved to '${host}'"
  [[ "${widgets}" == "${WIDGET_BUNDLE_IDENTIFIER}" ]] || die \
    "widget bundle identifier resolved to '${widgets}'"
  [[ "${share}" == "${SHARE_BUNDLE_IDENTIFIER}" ]] || die \
    "share bundle identifier resolved to '${share}'"
  printf '[swift-ios-device] bundle identifiers: %s, %s, %s\n' \
    "${host}" "${widgets}" "${share}"
}

if [[ "${T3_SWIFT_VERIFY_BUNDLE_IDENTIFIERS_ONLY:-0}" == "1" ]]; then
  verify_bundle_identifiers
  exit 0
fi

[[ -n "${DEVICE_ID}" ]] || die \
  "set T3_SWIFT_DEVICE_ID to a CoreDevice identifier or UDID from 'xcrun devicectl list devices --columns UDID'"
[[ -n "${DEVELOPMENT_TEAM}" ]] || die \
  "set T3_SWIFT_DEVELOPMENT_TEAM to your Apple Developer team ID"

build_settings=(
  "DEVELOPMENT_TEAM=${DEVELOPMENT_TEAM}"
)

DEVICE_JSON="$(mktemp -t t3-swift-devices.XXXXXX)"
trap 'unlink "${DEVICE_JSON}" 2>/dev/null || true' EXIT
xcrun devicectl list devices --json-output "${DEVICE_JSON}" --quiet >/dev/null
DESTINATION_ID="$(
  xcrun swift "${SCRIPT_DIR}/resolve-device-udid.swift" "${DEVICE_JSON}" "${DEVICE_ID}"
)" || die "could not resolve device '${DEVICE_ID}' to an Xcode destination UDID"

for key in \
  AOKI_CLERK_PUBLISHABLE_KEY \
  AOKI_CLERK_JWT_TEMPLATE \
  AOKI_RELAY_URL; do
  value="${!key:-}"
  if [[ -n "${value}" ]]; then
    build_settings+=("${key}=${value}")
  fi
done

if [[ -n "${T3_SWIFT_VERSION:-}" ]]; then
  build_settings+=("MARKETING_VERSION=${T3_SWIFT_VERSION}")
fi
if [[ -n "${T3_SWIFT_BUILD_NUMBER:-}" ]]; then
  build_settings+=("CURRENT_PROJECT_VERSION=${T3_SWIFT_BUILD_NUMBER}")
fi

inspect_profile() {
  local profile_path="$1"
  security cms -D -i "${profile_path}" | python3 -c '
import datetime, plistlib, sys
data = plistlib.loads(sys.stdin.buffer.read())
exp = data["ExpirationDate"]
if exp.tzinfo is None:
    exp = exp.replace(tzinfo=datetime.timezone.utc)
now = datetime.datetime.now(datetime.timezone.utc)
rem = int((exp - now).total_seconds())
app_id = data.get("Entitlements", {}).get("application-identifier", "")
uuid = data.get("UUID", "")
exp_str = exp.strftime("%Y-%m-%dT%H:%M:%SZ")
print(f"{uuid}\t{app_id}\t{exp_str}\t{rem}")
'
}

prune_expiring_profiles() {
  (( MIN_PROFILE_TTL_SECONDS > 0 )) || return 0
  [[ -d "${PROVISIONING_PROFILES_DIR}" ]] || return 0
  local profile uuid app_id exp_iso rem
  local expected_ids=(
    "${DEVELOPMENT_TEAM}.${BUNDLE_IDENTIFIER}"
    "${DEVELOPMENT_TEAM}.${WIDGET_BUNDLE_IDENTIFIER}"
    "${DEVELOPMENT_TEAM}.${SHARE_BUNDLE_IDENTIFIER}"
  )
  shopt -s nullglob
  for profile in "${PROVISIONING_PROFILES_DIR}"/*.mobileprovision; do
    IFS=$'\t' read -r uuid app_id exp_iso rem <<<"$(inspect_profile "${profile}")" || continue
    for expected in "${expected_ids[@]}"; do
      if [[ "${app_id}" == "${expected}" ]] && (( rem < MIN_PROFILE_TTL_SECONDS )); then
        mkdir -p "${EXPIRED_PROFILES_DIR}"
        printf '[swift-ios-device] moving expiring profile %s (%s, expires %s) to %s\n' \
          "${uuid}" "${app_id}" "${exp_iso}" "${EXPIRED_PROFILES_DIR}"
        mv "${profile}" "${EXPIRED_PROFILES_DIR}/"
        break
      fi
    done
  done
  shopt -u nullglob
}

verify_embedded_profiles() {
  (( MIN_PROFILE_TTL_SECONDS > 0 )) || return 0
  local target_path profile uuid app_id exp_iso rem hours
  for target_path in \
    "${APP_PATH}" \
    "${APP_PATH}/PlugIns/T3CodeWidgets.appex" \
    "${APP_PATH}/PlugIns/T3CodeShare.appex"; do
    profile="${target_path}/embedded.mobileprovision"
    [[ -f "${profile}" ]] || die "missing embedded provisioning profile at ${profile}"
    IFS=$'\t' read -r uuid app_id exp_iso rem <<<"$(inspect_profile "${profile}")" || die \
      "could not inspect embedded provisioning profile at ${profile}"
    hours="$((rem / 3600))"
    printf '[swift-ios-device] embedded profile %s (%s) expires %s (~%dh left)\n' \
      "${uuid}" "${app_id}" "${exp_iso}" "${hours}"
    if (( rem < MIN_PROFILE_TTL_SECONDS )); then
      die "embedded profile ${uuid} (${app_id}) expires at ${exp_iso} (~${hours}h left, below ${MIN_PROFILE_TTL_HOURS}h minimum); remove '${PROVISIONING_PROFILES_DIR}/${uuid}.mobileprovision' and rebuild, or set T3_SWIFT_MIN_PROFILE_TTL_HOURS=0"
    fi
  done
}

prune_expiring_profiles

printf '[swift-ios-device] building %s for %s\n' "${BUNDLE_IDENTIFIER}" "${DESTINATION_ID}"
xcodebuild build \
  -project "${APP_DIR}/T3Code.xcodeproj" \
  -scheme T3Code \
  -configuration "${CONFIGURATION}" \
  -destination "platform=iOS,id=${DESTINATION_ID}" \
  -derivedDataPath "${DERIVED_DATA_PATH}" \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  "${build_settings[@]}"

APP_PATH="${DERIVED_DATA_PATH}/Build/Products/${CONFIGURATION}-iphoneos/T3Code.app"
[[ -d "${APP_PATH}" ]] || die "built app was not found at ${APP_PATH}"

actual_host="$(plutil -extract CFBundleIdentifier raw -o - "${APP_PATH}/Info.plist")"
actual_widgets="$(
  plutil -extract CFBundleIdentifier raw -o - \
    "${APP_PATH}/PlugIns/T3CodeWidgets.appex/Info.plist"
)"
actual_share="$(
  plutil -extract CFBundleIdentifier raw -o - \
    "${APP_PATH}/PlugIns/T3CodeShare.appex/Info.plist"
)"
[[ "${actual_host}" == "${BUNDLE_IDENTIFIER}" ]] || die \
  "built host bundle identifier is '${actual_host}'"
[[ "${actual_widgets}" == "${WIDGET_BUNDLE_IDENTIFIER}" ]] || die \
  "built widget bundle identifier is '${actual_widgets}'"
[[ "${actual_share}" == "${SHARE_BUNDLE_IDENTIFIER}" ]] || die \
  "built share bundle identifier is '${actual_share}'"

verify_embedded_profiles

printf '[swift-ios-device] installing %s\n' "${APP_PATH}"
xcrun devicectl device install app --device "${DESTINATION_ID}" "${APP_PATH}"

printf '[swift-ios-device] launching %s\n' "${BUNDLE_IDENTIFIER}"
if ! launch_output="$(
  xcrun devicectl device process launch \
    --device "${DESTINATION_ID}" \
    "${BUNDLE_IDENTIFIER}" 2>&1
)"; then
  printf '%s\n' "${launch_output}" >&2
  if [[ "${launch_output}" == *"BSErrorCodeDescription = Locked"* ]]; then
    printf '[swift-ios-device] installed; unlock the device to launch the app\n'
    exit 0
  fi
  exit 1
fi
printf '%s\n' "${launch_output}"
