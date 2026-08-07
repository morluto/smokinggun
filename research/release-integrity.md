# Footgun release-integrity report

Audit date: 2026-08-05.

## Package contract

The package manifest is footgun@1.0.0. It exposes one executable, footgun, and
ships only the declared build output, pinned grammars, schema assets, skill
assets, lock metadata, README, and license. There is no lifecycle installer
and no implicit skill mutation during npm installation.

grammar.lock.json records each grammar repository, revision, npm source
version, generated WASM digest, ABI, and language aliases. Release verification
recomputes every digest and checks that the generated CLI entry point is
executable.

## Local evidence

The current verifier reports:

- 130 packed files;
- 2,219,742 compressed bytes;
- 26,042,153 unpacked bytes;
- no implicit installer, source map, test artifact, node_modules path, or
  undeclared package payload; and
- all 14 pinned grammars present.

The packed tarball was published to a temporary local Verdaccio registry and
installed into a consumer directory outside the checkout. npm installation,
npx execution from outside the checkout, global installation, scanner listing,
and doctor all succeeded; doctor loaded all 14 grammars. The packed skill was
present at `skills/footgun/SKILL.md`, and no agent directory was created during
npm installation.

## Skill distribution

The optional skill is installed with the shared Skills CLI:

```bash
npx skills add https://github.com/morluto/footgun --skill footgun
```

Footgun does not modify agent configuration or silently install packages.

## External release gate

Trusted npm publishing, registry freshness, and hosted Linux/macOS/Windows
validation remain release-environment operations. They are intentionally not
represented as successful local evidence.
