<?php

namespace App\Mcp\Tools;

use App\Mcp\Assets\AgentImages;
use App\Mcp\ToolError;
use App\Support\EnvironmentDefaults;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Support\Facades\Validator;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;

#[Name('take_photo')]
#[Description('Photo mode (F9), live in the open editor: renders a high-quality still in cinematic quality (converged anti-aliasing, full effects), optionally at 2× resolution, with a temporary `look` (any environment field as a preview, e.g. color_grade, color_grade_intensity, exposure_compensation, white_balance, dof_aperture, dof_max_blur, dof_focus_distance, lens_flare_intensity, film_grain, chromatic_aberration, letterbox, time_of_day, god_ray_intensity), a field of view and a depth-of-field `focus` point on screen. Nothing is saved to the map (set a look for good with update_environment) and the camera is put back. The full image is stored under agent-images/ (path in the result); a preview is returned.')]
class TakePhoto extends WaterwaysTool
{
    use CameraArguments;

    public function schema(JsonSchema $schema): array
    {
        return [
            'map' => $this->mapArgument($schema),
            ...$this->cameraSchema($schema),
            'look' => $schema->object()->description('Environment fields to preview for this photo (see get_settings group "environment").'),
            'fov' => $schema->number()->min(10)->max(110)->description('Field of view in degrees.'),
            'focus' => $schema->object([
                'x' => $schema->number()->min(-1)->max(1)->required(),
                'y' => $schema->number()->min(-1)->max(1)->required(),
            ])->description('Depth-of-field focus on a screen point (-1…1, 0,0 = centre), like "Click to focus".'),
            'cinematic' => $schema->boolean()->description('Cinematic render quality (default true).'),
            'scale' => $schema->integer()->enum([1, 2])->description('2 = render at twice the resolution (default 1).'),
            'max_width' => $schema->integer()->min(256)->max(1920)->description('Width of the returned preview (default 1280).'),
        ];
    }

    protected function run(Request $request): Response|ResponseFactory
    {
        $data = $request->validate([
            'look' => ['sometimes', 'array'],
            'fov' => ['sometimes', 'numeric', 'between:10,110'],
            'focus' => ['sometimes', 'array'],
            'focus.x' => ['required_with:focus', 'numeric', 'between:-1,1'],
            'focus.y' => ['required_with:focus', 'numeric', 'between:-1,1'],
            'cinematic' => ['sometimes', 'boolean'],
            'scale' => ['sometimes', 'in:1,2'],
            'max_width' => ['sometimes', 'integer', 'between:256,1920'],
        ]);
        $look = (array) ($data['look'] ?? []);
        $group = EnvironmentDefaults::group();
        $unknown = array_diff(array_keys($look), array_keys($group->defaults()));

        if ($unknown !== []) {
            throw new ToolError('Unknown environment fields in look: '.implode(', ', $unknown).'. See get_settings group "environment".');
        }

        $look = Validator::make($look, $group->rules())->validate();
        $map = $this->map($request);
        $result = $this->bridge()->run($map, 'photo', [
            ...$this->cameraPayload($request),
            'look' => (object) $look,
            'fov' => isset($data['fov']) ? (float) $data['fov'] : null,
            'focus' => $data['focus'] ?? null,
            'cinematic' => (bool) ($data['cinematic'] ?? true),
            'scale' => (int) ($data['scale'] ?? 1),
            'max_width' => (int) ($data['max_width'] ?? 1280),
        ], timeout: 90);

        $preview = base64_decode((string) ($result['image'] ?? ''), true);
        $full = base64_decode((string) ($result['full'] ?? ''), true);

        if ($preview === false || $preview === '') {
            throw new ToolError('The editor returned no image.');
        }

        $stored = $full !== false && $full !== '' ? app(AgentImages::class)->store($full, 'image/jpeg') : null;
        unset($result['image'], $result['full']);

        return Response::make([
            Response::image($preview, 'image/jpeg'),
            Response::text(json_encode(['map' => $map->slug, ...$result, 'stored' => $stored], JSON_UNESCAPED_SLASHES)),
        ]);
    }
}
