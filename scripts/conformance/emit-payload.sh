#!/bin/sh
# Emit the conformance payload from the real modules, for `conformance.json` -> payloadCommand.
#
# vitest is the only tool in this repo that can import the plugin's TypeScript sources (the CLI
# bundles for Electron, node cannot resolve extensionless TS imports). The test writes the payload
# built by `buildPanelModel` / `applyProviderChange` / `resolveReasoningDepth` to
# dist/conformance-payload.json; this wrapper then prints it on stdout, which is what the shared
# runner parses.
set -e
cd "$(dirname "$0")/../.."
mkdir -p evidence
DUALTRAN_EMIT_PAYLOAD=1 npx vitest run tests/conformance.test.ts >/dev/null 2>&1 || {
  echo "conformance payload test failed — run: npx vitest run tests/conformance.test.ts" >&2
  exit 1
}
cat evidence/conformance-payload.json
