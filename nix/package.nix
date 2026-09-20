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
        x86_64-linux = "sha256-ifyqzU1pDms2nTmSCDwITc2KYP88R9dz1YAeowz6cS8=";
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
    cp package.json "$out/package.json"
    cp ${../sanitize.schema.json} "$out/sanitize.schema.json"

    runHook postInstall
  '';

  meta = {
    description = "opencode plugin that reversibly pseudonymizes configured strings before context is sent to the LLM";
    platforms = lib.platforms.all;
  };
})
