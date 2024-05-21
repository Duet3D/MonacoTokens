# MonacoTokens

TypeScript library that holds syntax highlighting files for the Monaco editor

Currently exported Monaco languages:

- `gcodeFDMLanguage` (RRF G-code to be used in FFF mode)
- `gcodeCNCLanguage` (RRF G-code to be used in CNC and Laser mode)

After importing the languages, you need to register them as following:

```
monaco.languages.setMonarchTokensProvider("gcode-fdm", gcodeFDMLanguage);
monaco.languages.setMonarchTokensProvider("gcode-cnc", gcodeCNCLanguage);
```

## Bug reports

Please use the [forum](https://forum.duet3d.com) for support requests or the [DuetWebControl](https://github.com/Duet3D/DuetWebControl) GitHub repository for feature requests and bug reports.
