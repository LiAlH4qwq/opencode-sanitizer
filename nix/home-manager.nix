{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.opencode-sanitizer;
  jsonFormat = pkgs.formats.json { };
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
        loaded and applied together. See the package's
        {file}`sanitize.schema.json` for the schema.
      '';
      example = lib.literalExpression ''
        {
          rules = [
            {
              name = "false-positive-word";
              pattern = "example";
              literal = true;
            }
          ];
        }
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    xdg.configFile = {
      "opencode/plugins/opencode-sanitizer.js".text = builtins.readFile "${cfg.package}/sanitizer.js";
    }
    // lib.optionalAttrs (cfg.settings != { }) {
      "opencode-sanitizer/config.json".source = jsonFormat.generate "config.json" cfg.settings;
    };
  };
}
