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
    opencode.enable = lib.mkEnableOption "the opencode-sanitizer plugin for opencode";

    pi-coding-agent = {
      enable = lib.mkEnableOption "the opencode-sanitizer extension for the pi coding agent";

      agentDir = lib.mkOption {
        type = lib.types.str;
        default = ".pi/agent";
        description = ''
          Path of the pi agent directory, relative to {file}`$HOME`. The
          extension is linked into {file}`<agentDir>/extensions/`. Pi also
          honours the `PI_CODING_AGENT_DIR` environment variable, which this
          module cannot observe; set this option to match if you rely on it.
        '';
        example = ".config/pi/agent";
      };
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.opencode-sanitizer;
      defaultText = lib.literalExpression "pkgs.opencode-sanitizer";
      description = "Package providing the sanitizer plugin and pi extension.";
    };

    settings = lib.mkOption {
      inherit (jsonFormat) type;
      default = { };
      description = ''
        Sanitizer payload, rendered to
        {file}`$XDG_CONFIG_HOME/opencode-sanitizer/config.json`.
        This file and the project-level {file}`opencode-sanitizer.json` are both
        loaded and applied together, by both the opencode plugin and the pi
        extension. The payload is validated against the package's
        {file}`sanitize.schema.json` at build time, so invalid settings fail
        instead of being silently ignored.
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

  config = lib.mkMerge [
    (lib.mkIf cfg.opencode.enable {
      xdg.configFile = {
        "opencode/plugins/opencode-sanitizer.js".text = builtins.readFile "${cfg.package}/sanitizer.js";
      };
    })

    (lib.mkIf cfg.pi-coding-agent.enable {
      home.file."${cfg.pi-coding-agent.agentDir}/extensions/opencode-sanitizer.js".text = builtins.readFile "${cfg.package}/pi.js";
    })

    (lib.mkIf ((cfg.opencode.enable || cfg.pi-coding-agent.enable) && cfg.settings != { }) {
      xdg.configFile."opencode-sanitizer/config.json".source = validatedSettings;
    })
  ];
}
