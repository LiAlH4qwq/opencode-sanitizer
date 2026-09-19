{
  description = "opencode-sanitizer: an opencode plugin that sanitizes context before it reaches the LLM API";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    systems.url = "github:nix-systems/default";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } (
      {
        self,
        config,
        withSystem,
        ...
      }:
      {
        systems = import inputs.systems;

        perSystem =
          { pkgs, config, ... }:
          {
            packages.opencode-sanitizer = pkgs.callPackage ./nix/package.nix { };
            packages.default = config.packages.opencode-sanitizer;

            checks.opencode-sanitizer = config.packages.opencode-sanitizer;
            checks.default = config.checks.opencode-sanitizer;

            formatter = pkgs.nixfmt;
          };

        flake = {
          overlays.opencode-sanitizer = final: prev: {
            opencode-sanitizer = self.packages.${final.stdenv.hostPlatform.system}.opencode-sanitizer;
          };
          overlays.default = config.flake.overlays.opencode-sanitizer;

          homeModules.opencode-sanitizer =
            { lib, pkgs, ... }:
            {
              imports = [ ./nix/home-manager.nix ];
              services.opencode-sanitizer.package = lib.mkDefault (
                withSystem pkgs.stdenv.hostPlatform.system ({ config, ... }: config.packages.opencode-sanitizer)
              );
            };
          homeModules.default = config.flake.homeModules.opencode-sanitizer;
        };
      }
    );
}
