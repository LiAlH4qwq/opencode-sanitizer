{
  lib,
  stdenvNoCC,
  nodejs_24,
  pnpm_12,
  fetchPnpmDeps,
  pnpmConfigHook,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../rolldown.config.ts
      ../tsconfig.json
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash =
      {
        x86_64-linux = "sha256-MkHKWJIjKG5d5YPvAymKoOo3l3kwLkcOqTUDUAuTSak=";
      }
      .${stdenvNoCC.hostPlatform.system} or lib.fakeHash;
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_12
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp dist/sanitizer.js "$out/sanitizer.js"
    cp dist/pi.js "$out/pi.js"
    cp package.json "$out/package.json"
    cp ${../sanitize.schema.json} "$out/sanitize.schema.json"

    runHook postInstall
  '';

  meta = {
    description = "Reversibly pseudonymizes configured strings before context reaches the LLM, for opencode and the pi coding agent";
    platforms = lib.platforms.all;
  };
})
