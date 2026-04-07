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
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-codedb";
            version = "1.0.4";

            src = self;

            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/pi/packages/pi-codedb
              cp -r extensions skills package.json $out/share/pi/packages/pi-codedb/
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
