// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FrontctlSetup",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "FrontctlSetup", targets: ["FrontctlSetup"])
    ],
    targets: [
        .executableTarget(name: "FrontctlSetup")
    ]
)
