{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.opencode-sanitizer;
  jsonFormat = pkgs.formats.json { };

  settingsFile = jsonFormat.generate "opencode-sanitizer.json" cfg.settings;

  # Validate the user's settings against the plugin's JSON schema before the
  # config is linked, so a typo fails `home-manager switch` instead of silently
  # dropping the intended rule.
  validatedSettings =
    pkgs.runCommand "opencode-sanitizer-config.json"
      {
        nativeBuildInputs = [ pkgs.check-jsonschema ];
      }
      ''
        check-jsonschema --schemafile ${cfg.package}/sanitize.schema.json ${settingsFile}
        cp ${settingsFile} $out
      '';
in
{
  options.services.opencode-sanitizer = {
    enable = lib.mkEnableOption "the opencode-sanitizer plugin";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.opencode-sanitizer;
      defaultText = lib.literalExpression "pkgs.opencode-sanitizer";
      description = "Package providing the sanitizer plugin.";
    };

    settings = lib.mkOption {
      inherit (jsonFormat) type;
      default = { };
      description = ''
        Sanitizer payload, rendered to
        {file}`$XDG_CONFIG_HOME/opencode-sanitizer/config.json`.
        This file and the project-level {file}`opencode-sanitizer.json` are both
        loaded and applied together. The payload is validated against the
        package's {file}`sanitize.schema.json` at build time, so invalid
        settings fail instead of being silently ignored.
      '';
      example = lib.literalExpression ''
        {
          rules = {
            false-positive-word = {
              pattern = "example";
              literal = true;
            };
          };
        }
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    xdg.configFile = {
      "opencode/plugins/opencode-sanitizer.js".text = builtins.readFile "${cfg.package}/sanitizer.js";
    }
    // lib.optionalAttrs (cfg.settings != { }) {
      "opencode-sanitizer/config.json".source = validatedSettings;
    };
  };
}
