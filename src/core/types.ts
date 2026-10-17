export type Vec3 = [number, number, number];

/** A closed 2D contour list (outer shapes and holes), in millimetres, Y up. */
export type Polygons = [number, number][][];

export type ShapeKind =
  | 'box'
  | 'roundBox'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'halfSphere'
  | 'pyramid'
  | 'wedge'
  | 'torus'
  | 'tube'
  | 'star'
  | 'heart'
  | 'text'
  | 'svg'
  | 'mesh'
  | 'group';

export type ParamValue = number | string | boolean | Polygons;
export type Params = Record<string, ParamValue>;

/**
 * One object of the design. Primitives are generated from `params`; groups
 * combine their `children` (solids united, holes subtracted).
 * Transform order: scale, then rotate (XYZ, degrees), then translate.
 */
export interface SceneNode {
  id: string;
  name: string;
  kind: ShapeKind;
  params: Params;
  hole: boolean;
  color: string;
  /** Filament (core/filaments.ts) this object is painted with, if any. */
  filament?: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  locked?: boolean;
  hidden?: boolean;
  children?: SceneNode[];
}

/** Raw triangle mesh imported from STL/OBJ, kept beside the node tree. */
export interface MeshAsset {
  positions: number[];
  indices: number[];
}

export interface DesignDoc {
  version: 1;
  title: string;
  nodes: SceneNode[];
  assets: Record<string, MeshAsset>;
}

export const emptyDoc = (): DesignDoc => ({
  version: 1,
  title: 'Projeto sem título',
  nodes: [],
  assets: {},
});
