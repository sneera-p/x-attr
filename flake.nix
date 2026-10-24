{
  description = "x-attributes: dev environment (Bun, Node, Playwright)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # playwright-driver.browsers is only packaged for Linux in nixpkgs
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun            # package manager, bundler, unit tests (bun test)
            pkgs.nodejs         # Playwright's test runner runs on Node, not Bun
            pkgs.playwright-driver.browsers
          ];

          # Use the browsers from nixpkgs instead of letting Playwright download its own.
          # @playwright/test in package.json must be pinned to EXACTLY this version,
          # or Playwright will look for browser builds that aren't there.
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          PLAYWRIGHT_VERSION = pkgs.playwright-driver.version;

          shellHook = ''
            echo "bun $(bun --version) | node $(node --version) | playwright browsers $PLAYWRIGHT_VERSION"
            echo "pin @playwright/test to: $PLAYWRIGHT_VERSION"
          '';
        };
      });
    };
}
