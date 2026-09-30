<?php

namespace App\Mcp\Tools;

use App\Models\Character;
use App\Support\ActiveCharacter;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

#[Name('list_characters')]
#[IsReadOnly]
#[Description('The character library (Studio → Characters): player characters generated with Meshy (rigged and animated) or uploaded, with status, height, animation clips and which one is the player character (`active`; none = the default character). Change them with manage_character.')]
class ListCharacters extends WaterwaysTool
{
    protected function run(Request $request): Response
    {
        $active = app(ActiveCharacter::class)->id();

        return $this->json([
            'active_id' => $active,
            'characters' => Character::query()->latest()->latest('id')->get()->map(fn (Character $c) => [
                'id' => $c->id,
                'name' => $c->name,
                'source' => $c->source,
                'status' => $c->status,
                'status_message' => $c->status_message,
                'height' => $c->height,
                'clips' => array_keys($c->animations ?? []),
                'prompt' => $c->prompt,
                'active' => $c->id === $active,
                'thumbnail_url' => $c->toStudioArray()['thumbnail_url'],
            ])->values(),
        ]);
    }
}
