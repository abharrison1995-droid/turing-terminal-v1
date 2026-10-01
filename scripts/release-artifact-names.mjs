export function releaseArtifactNames(version) {
  return {
    windows: `Turing-Terminal-Setup-x64-${version}.exe`,
    deb: `turing-terminal_${version}_amd64.deb`,
    appimage: `Turing-Terminal-x86_64-${version}.AppImage`,
  };
}
