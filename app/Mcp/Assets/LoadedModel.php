<?php

namespace App\Mcp\Assets;

/**
 * A checked model file ready to import (see ModelSource).
 */
final readonly class LoadedModel
{
    /**
     * @param  string  $path  local file (possibly temporary)
     * @param  string  $name  original file name
     * @param  'glb'|'gltf'|'zip'  $extension  zip = a .gltf packed with its external files
     * @param  array<string, mixed>  $document  the glTF JSON
     */
    public function __construct(
        public string $path,
        public string $name,
        public string $extension,
        public array $document,
    ) {}
}
