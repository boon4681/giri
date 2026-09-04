[windows]
set shell := ["powershell.exe", "-NoLogo", "-Command"]
set dotenv-load := true

add probe:
    yarn build
    yarn --cwd "{{probe}}" add "@boon4681/giri@portal:{{justfile_directory()}}"
