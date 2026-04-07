{
  description = "Code intelligence extension for pi-coding-agent via codedb REST API";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      codedbVersion = "0.2.54";
      codedbHashes = {
        x86_64-linux = "061nzail0cqs598qk0jb6h2bfngk70cddhkjcibkj3v69vx1vmib";
        aarch64-linux = "1liwssj5y9m96j6hzj4gk5nhrvmckyfvnsmzi1byv0p0bkirwf3s";
        x86_64-darwin = "0s12xnak5rrr32r8j84rdnpzn8jn3xx8h14hh03fi0kfmcrqy0nj";
        aarch64-darwin = "18wi4gv776mixf0hgdbhz5rklqx6wdyn9m9q5mkl8mq8pjd17s98";
      };
      codedbPlatforms = {
        x86_64-linux = "linux-x86_64";
        aarch64-linux = "linux-aarch64";
        x86_64-darwin = "darwin-x86_64";
        aarch64-darwin = "darwin-arm64";
      };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          platform = codedbPlatforms.${system};
        in
        {
          codedb = pkgs.stdenvNoCC.mkDerivation {
            pname = "codedb";
            version = codedbVersion;

            src = pkgs.fetchurl {
              url = "https://github.com/justrach/codedb/releases/download/v${codedbVersion}/codedb-${platform}";
              sha256 = codedbHashes.${system};
            };

            dontUnpack = true;

            installPhase = ''
              runHook preInstall
              install -Dm755 $src $out/bin/codedb
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Code intelligence server — structural indexing, trigram search, symbol lookup";
              homepage = "https://github.com/justrach/codedb";
              license = licenses.bsd3;
              platforms = [
                "x86_64-linux"
                "aarch64-linux"
                "x86_64-darwin"
                "aarch64-darwin"
              ];
            };
          };

          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-codedb";
            version = "1.1.0"; # x-release-please-version

            src = self;

            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/pi/packages/pi-codedb
              cp -r extensions skills package.json THIRD_PARTY_LICENSES.md $out/share/pi/packages/pi-codedb/
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Code intelligence extension for pi-coding-agent via codedb REST API";
              homepage = "https://github.com/ryo-morimoto/pi-codedb";
              license = licenses.mit;
              platforms = platforms.all;
            };
          };
        }
      );
    };
}
