import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// preserve the contact without cloudflare's script-based email decoder
test("privacy contact opts out of CDN email rewriting", () => {
  const policy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
  assert.match(
    policy,
    /<!--email_off--><a href="mailto:sanctuary@ballydidean\.farm">sanctuary@ballydidean\.farm<\/a><!--\/email_off-->/u,
  );
  assert.doesNotMatch(policy, /<script\b/u);
});
