// ClusteredMarkersLayer.ts

import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Color,
  CustomDataSource,
  Entity,
  JulianDate,
  PropertyBag,
  Rectangle,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import { CycleData, MarkerData } from './marker.model';


export interface PillStyle {
  fontFamily: string;
  fontPx: number;
  paddingX: number;
  paddingY: number;
  backgroundColor: string;
  textColor: string;
  separatorColor: string;
  dotDiameterPx: number;
  dotGapPx: number;
  loadDotColor: string;
  dumpDotColor: string;
}

export interface ClusteredMarkersOptions {
  enabled?: boolean;
  pixelRange?: number;
  minimumClusterSize?: number;
  labelPrefix?: string;
  pointPixelSize?: number;
  getPointColor?: (evt: CycleData) => Color;

  pillStyle?: PillStyle;

  autoZoom?: boolean;

  // Callbacks
  onMarkerClick?: (args: { entity: Entity; event?: CycleData; lat: number; lon: number }) => void;
  onClusterClick?: (args: { clusterEntity: Entity; members: Entity[]; lat: number; lon: number }) => void;

  dataSourceName?: string;

  // Decluster zoom config
  ensureDeclusterOnClick?: boolean;
  minSeparationPx?: number;
  maxZoomIters?: number;
  mixedExtraZoomFactor?: number;
  singleExtraZoomFactor?: number;

  // Popup config
  popupEnabled?: boolean;
  buildPopupHtml?: (evt: CycleData, entity: Entity) => string;
}

export class ClusteredMarkersLayer {
  public readonly viewer: Viewer;
  public readonly dataSource: CustomDataSource;
  public options: Required<ClusteredMarkersOptions>;

  private clickHandler?: ScreenSpaceEventHandler;
  private markerIds = new Set<string>();
  private clusterMembers = new Map<any, Entity[]>();

  private clusterStyler: (clusteredEntities: Entity[], cluster: any) => void;

  private popupEl?: HTMLDivElement;
  private popupAnchor?: Entity;
  private popupTrackUnsub?: () => void;
  private carousel?: { entities: Entity[]; index: number; anchor: Entity };

  constructor(viewer: Viewer, data: MarkerData[], options?: ClusteredMarkersOptions) {
    this.viewer = viewer;

    const defaults: Required<ClusteredMarkersOptions> = {
      enabled: true,
      pixelRange: 60,
      minimumClusterSize: 2,
      labelPrefix: 'L',
      pointPixelSize: 10,
      getPointColor: (evt: CycleData) => {
        return Color.fromBytes(evt.color.r, evt.color.g, evt.color.b, 255);
      },
      pillStyle: {
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontPx: 18,
        paddingX: 12,
        paddingY: 6,
        backgroundColor: 'whitesmoke',
        textColor: '#000000',
        separatorColor: '#000000',
        dotDiameterPx: 10,
        dotGapPx: 6,
        loadDotColor: 'rgb(152, 38, 222)',
        dumpDotColor: 'rgb(254, 90, 171)',
      },
      autoZoom: true,
      onMarkerClick: () => { },
      onClusterClick: () => { },
      dataSourceName: 'clusteredMarkers',
      ensureDeclusterOnClick: true,
      minSeparationPx: 64,
      maxZoomIters: 6,
      mixedExtraZoomFactor: 0.85,
      singleExtraZoomFactor: 0.9,
      popupEnabled: true,
      buildPopupHtml: undefined as any,
    };

    this.options = { ...defaults, ...(options || {}) };
    if (!options?.minSeparationPx) {
      this.options.minSeparationPx = (options?.pixelRange ?? this.options.pixelRange) + 4;
    }

    this.dataSource = new CustomDataSource(this.options.dataSourceName);
    void this.viewer.dataSources.add(this.dataSource);

    // Cluster styler → L / D / Mixed pill
    this.clusterStyler = (clusteredEntities, cluster) => {
      const { load, dump } = this.getLoadDumpCounts(clusteredEntities);

      cluster.label.show = false;

      let out: { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number };
      if (load > 0 && dump === 0) {
        out = this.getClusterSingleCanvas('L', load, this.options.pillStyle);
      } else if (dump > 0 && load === 0) {
        out = this.getClusterSingleCanvas('D', dump, this.options.pillStyle);
      } else {
        out = this.getClusterMixedCanvas({ load, dump }, this.options.pillStyle);
      }

      cluster.billboard.show = true;
      cluster.billboard.image = out.canvas.toDataURL('image/png');
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
      cluster.billboard.width = out.cssWidth;
      cluster.billboard.height = out.cssHeight;

      // unify picking
      const sharedId = cluster.label.id;
      cluster.billboard.id = sharedId;
      if (cluster.point) cluster.point.id = sharedId;

      // store members
      this.clusterMembers.set(sharedId, clusteredEntities);
    };

    this.setData(data);
    this.configureClustering();
    if (this.options.autoZoom) void this.zoomTo();

    // keyboard
    window.addEventListener('keydown', (e) => {
      if (!this.popupEl || this.popupEl.style.display !== 'block') return;
      if (e.key === 'Escape') this.hidePopup();
      if (this.carousel) {
        if (e.key === 'ArrowLeft') this.carouselPrev();
        if (e.key === 'ArrowRight') this.carouselNext();
      }
    });
  }

  public setData(markers: MarkerData[]): void {
    this.clusterMembers.clear();
    this.markerIds.clear();
    this.dataSource.entities.removeAll();

    for (const marker of markers) {
      if (!isFinite(marker.point.lat) || !isFinite(marker.point.lng)) continue;
      const position = Cartesian3.fromDegrees(marker.point.lng, marker.point.lat, 0);

      const entity = this.dataSource.entities.add({
        position,
        point: {
          pixelSize: 8,
          color: Color.fromCssColorString(marker.options.color),
          outlineColor: Color.WHITESMOKE,
          outlineWidth: 2,
        },
      });

      // store JSON for popup
      entity.properties = new PropertyBag(marker.popupData as any);
      (entity as any).__event = marker.popupData;

      this.markerIds.add(entity.id);
    }

    this.forceClusterRefresh();
    if (this.options.autoZoom) void this.zoomTo();
  }

  public configureClustering(opts?: Partial<ClusteredMarkersOptions>): void {
    if (opts) {
      this.options = { ...this.options, ...opts };
      if (opts.pixelRange && !opts.minSeparationPx) {
        this.options.minSeparationPx = this.options.pixelRange + 4;
      }
    }

    const clustering = this.dataSource.clustering;
    clustering.enabled = this.options.enabled;
    clustering.pixelRange = this.options.pixelRange;
    clustering.minimumClusterSize = this.options.minimumClusterSize;

    clustering.clusterEvent.removeEventListener(this.clusterStyler);
    clustering.clusterEvent.addEventListener(this.clusterStyler);

    this.forceClusterRefresh();
    if (!this.clickHandler) this.installClickHandler();
  }

  public async zoomTo(): Promise<void> {
    try { await this.viewer.zoomTo(this.dataSource); } catch { }
  }

  public async dispose(): Promise<void> {
    this.dataSource.clustering.clusterEvent.removeEventListener(this.clusterStyler);
    if (this.clickHandler) { this.clickHandler.destroy(); this.clickHandler = undefined; }
    try { await this.viewer.dataSources.remove(this.dataSource, true); } catch { }
    this.clusterMembers.clear();
    this.markerIds.clear();
    this.hidePopup();
  }

  // ----------------------
  // Click handling
  // ----------------------

  private installClickHandler(): void {
    this.clickHandler?.destroy();
    this.clickHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

    // LEFT CLICK
    this.clickHandler.setInputAction(async (movement) => {
      const picked = this.viewer.scene.pick(movement.position);

      // If clicked on EMPTY SPACE: close popup and return
      if (!picked || !picked.id) {
        this.hidePopup();
        return;
      }

      const entity = picked.id as Entity;
      const now = JulianDate.now();
      const pos = (entity as any).position?.getValue?.(now);
      if (!pos) {
        this.hidePopup();
        return;
      }

      const carto = Cartographic.fromCartesian(pos);
      const lat = CesiumMath.toDegrees(carto.latitude);
      const lon = CesiumMath.toDegrees(carto.longitude);

      const key = picked.id;

      // --- Cluster clicked ---
      if (this.clusterMembers.has(key)) {
        const members = this.clusterMembers.get(key)!;
        console.log(members);

        const { load, dump } = this.getLoadDumpCounts(members);

        if (this.options.onClusterClick) {
          this.options.onClusterClick({ clusterEntity: entity, members, lat, lon });
        }

        if (this.options.ensureDeclusterOnClick) {
          const isMixed = load > 0 && dump > 0;
          await this.zoomToSeparate(members, {
            targetMinPx: this.options.minSeparationPx,
            maxSteps: this.options.maxZoomIters,
            perStepFactor: isMixed ? this.options.mixedExtraZoomFactor : this.options.singleExtraZoomFactor,
          });
        } else {
          await this.zoomToEntitiesOnce(members);
        }

        // Hide popup when zooming to clusters
        this.hidePopup();
        return;
      }

      // --- Single marker clicked ---
      if (entity.id && this.markerIds.has(entity.id)) {
        const evt: CycleData | undefined = (entity as any).__event;

        if (this.options.onMarkerClick) {
          this.options.onMarkerClick({ entity, event: evt, lat, lon });
        }

        // Drill for same-place markers
        const picks = this.viewer.scene.drillPick(movement.position) as any[];
        const now2 = JulianDate.now();
        const refPos = (entity as any).position?.getValue?.(now2);

        const allMarkerEntities = picks
          .map((p) => p?.id as Entity)
          .filter((e): e is Entity => !!e && !!(e as any).__event && this.markerIds.has(e.id));

        const samePlace: Entity[] = [];
        for (const e of allMarkerEntities) {
          const p = (e as any).position?.getValue?.(now2);
          if (!p) continue;
          if (Cartesian3.distance(refPos, p) <= 1.0) samePlace.push(e);
        }

        if (samePlace.length > 1) {
          // Show carousel anchored at clicked entity
          this.showCarouselPopup(samePlace, entity);
        } else if (this.options.popupEnabled) {
          const html = this.options.buildPopupHtml
            ? this.options.buildPopupHtml(evt!, entity)
            : this.buildDefaultPopupHtml(evt!, lat, lon);
          this.showPopupAt(entity, html);
        }
        return;
      }

      // If some other non-marker primitive: close popup
      this.hidePopup();
    }, ScreenSpaceEventType.LEFT_CLICK);

    // RIGHT CLICK → close popup
    this.clickHandler.setInputAction(() => this.hidePopup(), ScreenSpaceEventType.RIGHT_CLICK);
  }

  /**
   * Force cluster rebuild (EntityCluster has no recluster() public API)
   */
  private forceClusterRefresh(): void {
    const c = this.dataSource.clustering;
    const prev = c.pixelRange;
    c.pixelRange = prev === 0 ? 1 : 0;
    c.pixelRange = prev;
    this.viewer.scene.requestRender();
  }

  private getInitials(phrase) {
    // Split the phrase into words
    const words = phrase.trim().split(/\s+/);
    // Get the first letter of each word and join them in uppercase
    const initials = words.map(word => word[0].toUpperCase()).join('');
    return initials;
  }


  private getLoadDumpCounts(entities: Entity[]): { load: number; dump: number } {
    console.log(entities);

    let load = 0, dump = 0;
    for (const e of entities) {
      const evt = (e as any).__event;
      console.log(evt)
      if (evt['segmentDesc']) {
        const seg = (evt['segmentDesc'] || '').toLowerCase();
        if (seg.includes('load')) load++;
        else if (seg.includes('dump')) dump++;
      }


    }
    return { load, dump };
  }

  // ----------------------
  // Zoom helpers
  // ----------------------

  private rectangleFromEntities(entities: Entity): Rectangle;
  private rectangleFromEntities(entities: Entity[]): Rectangle;
  private rectangleFromEntities(entities: Entity | Entity[]): Rectangle {
    const arr = Array.isArray(entities) ? entities : [entities];
    const now = JulianDate.now();
    const cartos: Cartographic[] = [];
    for (const e of arr) {
      const p = (e as any).position?.getValue?.(now);
      if (!p) continue;
      cartos.push(Cartographic.fromCartesian(p));
    }
    if (cartos.length === 0) return undefined as any;

    const rect = Rectangle.fromCartographicArray(cartos);
    if (rect.west === rect.east && rect.north === rect.south) {
      return this.expandRectangle(rect, CesiumMath.toRadians(0.0005));
    }
    return rect;
  }

  private expandRectangle(rect: Rectangle, padRad: number): Rectangle {
    return new Rectangle(rect.west - padRad, rect.south - padRad, rect.east + padRad, rect.north + padRad);
  }

  private async zoomToEntitiesOnce(entities: Entity[]): Promise<void> {
    let rect = this.rectangleFromEntities(entities);
    if (!rect) return;
    rect = this.expandRectangle(rect, CesiumMath.toRadians(0.01));
    await this.flyToRectangle(rect, 0.8);
  }

  private async zoomToSeparate(
    entities: Entity[],
    opts?: { targetMinPx?: number; maxSteps?: number; perStepFactor?: number }
  ): Promise<void> {
    const targetMinPx = opts?.targetMinPx ?? (this.options.pixelRange + 4);
    const maxSteps = opts?.maxSteps ?? 6;
    const perStepFactor = opts?.perStepFactor ?? 0.9;

    let rect = this.rectangleFromEntities(entities);
    if (!rect) return;

    await this.flyToRectangle(rect, 0.8);
    await this.waitOnePostRender();

    for (let step = 0; step < maxSteps; step++) {
      const minPx = this.minPixelSeparation(entities);
      if (minPx === Infinity || minPx >= targetMinPx) break;

      rect = this.shrinkRectangle(rect, perStepFactor);
      await this.flyToRectangle(rect, 0.5);
      await this.waitOnePostRender();

      this.forceClusterRefresh();
      await this.waitOnePostRender();
    }
  }

  private shrinkRectangle(rect: Rectangle, factor: number): Rectangle {
    const cx = (rect.west + rect.east) / 2;
    const cy = (rect.south + rect.north) / 2;
    const hw = (rect.east - rect.west) * 0.5 * factor;
    const hh = (rect.north - rect.south) * 0.5 * factor;
    return new Rectangle(cx - hw, cy - hh, cx + hw, cy + hh);
  }

  private flyToRectangle(rect: Rectangle, duration = 0.8): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        this.viewer.camera.flyTo({
          destination: rect,
          duration,
          complete: () => resolve(),
          cancel: () => resolve(),
        });
      } catch {
        resolve();
      }
    });
  }

  private waitOnePostRender(): Promise<void> {
    return new Promise<void>((resolve) => {
      const scene = this.viewer.scene;
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
      scene.requestRender();
    });
  }

  private minPixelSeparation(entities: Entity[]): number {
    const scene = this.viewer.scene;
    const now = JulianDate.now();
    const pts: Cartesian2[] = [];

    for (const e of entities) {
      const pos = (e as any).position?.getValue?.(now);
      if (!pos) continue;
      const win = SceneTransforms.worldToWindowCoordinates(scene, pos);
      if (win) pts.push(win);
    }
    if (pts.length < 2) return Infinity;

    let min = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i].x - pts[j].x;
        const dy = pts[i].y - pts[j].y;
        const d = Math.hypot(dx, dy);
        if (d < min) min = d;
      }
    }
    return min;
  }

  // ----------------------
  // Popup + Carousel
  // ----------------------

  private ensurePopupEl(): void {
    if (this.popupEl) return;
    const el = document.createElement('div');
    el.className = 'cm-popup';
    Object.assign(el.style, {
      position: 'absolute',
      display: 'none',
      zIndex: '1000',
      background: '#fff',
      color: '#111',
      padding: '10px 12px',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      pointerEvents: 'auto',
      maxWidth: '320px',
      fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      fontSize: '12px',
      lineHeight: '1.4',
      border: '1px solid #e8e8e8',
    } as CSSStyleDeclaration);
    this.viewer.container.appendChild(el);
    this.popupEl = el;
  }

  private enablePopupTracking(): void {
    this.disablePopupTracking();
    const anchor = this.carousel?.anchor ?? this.popupAnchor;
    if (!anchor) return;
    const scene = this.viewer.scene;
    const tick = () => this.positionPopupAt(anchor);
    const remove = scene.postRender.addEventListener(tick);
    this.popupTrackUnsub = remove;
  }

  private disablePopupTracking(): void {
    if (this.popupTrackUnsub) {
      this.popupTrackUnsub();
      this.popupTrackUnsub = undefined;
    }
  }

  private positionPopupAt(entity: Entity): void {
    if (!this.popupEl) return;
    const now = JulianDate.now();
    const pos = (entity as any).position?.getValue?.(now);
    if (!pos) return;
    const win = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, pos);
    if (!win) return;
    this.popupEl.style.left = `${win.x + 12}px`;
    this.popupEl.style.top = `${win.y - 12}px`;
  }

  private showPopupAt(entity: Entity, html: string): void {
    this.ensurePopupEl();
    if (!this.popupEl) return;
    this.carousel = undefined;
    this.popupAnchor = entity;
    this.popupEl.innerHTML = html;
    this.popupEl.style.display = 'block';
    this.positionPopupAt(entity);
    this.enablePopupTracking();
  }

  private hidePopup(): void {
    if (this.popupEl) this.popupEl.style.display = 'none';
    this.carousel = undefined;
    this.popupAnchor = undefined;
    this.disablePopupTracking();
  }

  private showCarouselPopup(entities: Entity[], anchor: Entity): void {
    this.ensurePopupEl();
    if (!this.popupEl) return;

    this.carousel = { entities, index: 0, anchor };
    this.popupAnchor = undefined; // carousel uses its own anchor

    this.popupEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="cm-prev" title="Previous" style="
          border:1px solid #ddd; background:#f9f9f9; border-radius:6px; padding:6px 8px; cursor:pointer;">◀</button>
        <div class="cm-content" style="flex:1; min-width:220px;"></div>
        <button class="cm-next" title="Next" style="
          border:1px solid #ddd; background:#f9f9f9; border-radius:6px; padding:6px 8px; cursor:pointer;">▶</button>
      </div>
      <div class="cm-indicator" style="margin-top:6px; text-align:center; color:#666; font-weight:600;"></div>
    `;
    this.popupEl.style.display = 'block';

    const prevBtn = this.popupEl.querySelector<HTMLButtonElement>('.cm-prev')!;
    const nextBtn = this.popupEl.querySelector<HTMLButtonElement>('.cm-next')!;
    prevBtn.onclick = () => this.carouselPrev();
    nextBtn.onclick = () => this.carouselNext();

    this.renderCarouselSlide();
    this.positionPopupAt(anchor);
    this.enablePopupTracking();
  }

  private carouselPrev(): void {
    if (!this.carousel) return;
    const n = this.carousel.entities.length;
    this.carousel.index = (this.carousel.index - 1 + n) % n;
    this.renderCarouselSlide();
  }

  private carouselNext(): void {
    if (!this.carousel) return;
    const n = this.carousel.entities.length;
    this.carousel.index = (this.carousel.index + 1) % n;
    this.renderCarouselSlide();
  }

  private renderCarouselSlide(): void {
    if (!this.carousel || !this.popupEl) return;
    const { entities, index, anchor } = this.carousel;

    const e = entities[index];
    const now = JulianDate.now();
    const pos = (e as any).position?.getValue?.(now);
    const carto = pos ? Cartographic.fromCartesian(pos) : undefined;
    const lat = carto ? CesiumMath.toDegrees(carto.latitude) : NaN;
    const lon = carto ? CesiumMath.toDegrees(carto.longitude) : NaN;

    const evt: CycleData | undefined = (e as any).__event;
    const html = this.options.buildPopupHtml
      ? this.options.buildPopupHtml(evt!, e)
      : this.buildDefaultPopupHtml(evt!, lat, lon);

    const content = this.popupEl.querySelector<HTMLDivElement>('.cm-content')!;
    const indicator = this.popupEl.querySelector<HTMLDivElement>('.cm-indicator')!;
    content.innerHTML = html;
    indicator.textContent = `${index + 1} / ${entities.length}`;

    // keep it positioned at the carousel anchor
    this.positionPopupAt(anchor);
  }

  private buildDefaultPopupHtml(evt: CycleData | undefined, lat: number, lon: number): string {
    if (!evt) {
      return `<div><strong>Marker</strong><br/>Lat: ${lat.toFixed(6)}, Lon: ${lon.toFixed(6)}</div>`;
    }
    const rows = Object.entries(evt as any)
      .map(([k, v]) => {
        const val = v === null || v === undefined ? '' : String(v);
        return `<div style="display:flex;gap:8px;margin:2px 0;">
          <div style="min-width:120px;color:#666;">${this.escape(k)}</div>
          <div style="flex:1;font-weight:600;">${this.escape(val)}</div>
        </div>`;
      })
      .join('');
    return `
      <div>
        <div style="font-weight:700;margin-bottom:6px;">Details</div>
        ${rows}
        <hr style="margin:8px 0;border:none;border-top:1px solid #eee;" />
        <div style="color:#666;">Lat: ${isFinite(lat) ? lat.toFixed(6) : '-'}, Lon: ${isFinite(lon) ? lon.toFixed(6) : '-'}</div>
      </div>
    `;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ----------------------
  // Cluster pill canvas drawing
  // ----------------------

  private getClusterSingleCanvas(
    kind: 'L' | 'D',
    count: number,
    style: PillStyle
  ): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } {
    const ctxMeasure = document.createElement('canvas').getContext('2d')!;
    ctxMeasure.font = `${style.fontPx}px ${style.fontFamily}`;
    const text = `${kind} ${count}`;
    const textWidth = ctxMeasure.measureText(text).width;

    const dot = style.dotDiameterPx;
    const gap = style.dotGapPx;

    const innerWidth = dot + gap + textWidth;
    const cssWidth = Math.ceil(innerWidth + style.paddingX * 2);
    const cssHeight = Math.ceil(style.fontPx + style.paddingY * 2);

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    this.roundedRect(ctx, 0.5, 0.5, cssWidth - 1, cssHeight - 1, Math.min(10, cssHeight / 2 - 1), style.backgroundColor);

    // Dot
    const dotColor = kind === 'L' ? style.loadDotColor : style.dumpDotColor;
    const cx = style.paddingX + dot / 2;
    const cy = cssHeight / 2;
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(cx, cy, dot / 2, 0, Math.PI * 2);
    ctx.fill();

    // Text
    ctx.font = `${style.fontPx}px ${style.fontFamily}`;
    ctx.fillStyle = style.textColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, style.paddingX + dot + gap, cy + 0.5);

    return { canvas, cssWidth, cssHeight };
  }

  private getClusterMixedCanvas(
    counts: { load: number; dump: number },
    style: PillStyle
  ): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } {
    const ctxMeasure = document.createElement('canvas').getContext('2d')!;
    ctxMeasure.font = `${style.fontPx}px ${style.fontFamily}`;
    const textL = `L ${counts.load}`;
    const textD = `D ${counts.dump}`;
    const wL = ctxMeasure.measureText(textL).width;
    const wD = ctxMeasure.measureText(textD).width;

    const dot = style.dotDiameterPx;
    const gap = style.dotGapPx;
    const sep = Math.max(1, Math.floor(style.dotGapPx));

    const leftInner = dot + gap + wL;
    const rightInner = dot + gap + wD;
    const innerWidth = leftInner + sep + rightInner;

    const cssWidth = Math.ceil(innerWidth + style.paddingX * 2);
    const cssHeight = Math.ceil(style.fontPx + style.paddingY * 2);

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    this.roundedRect(ctx, 0.5, 0.5, cssWidth - 1, cssHeight - 1, Math.min(10, cssHeight / 2 - 1), style.backgroundColor);

    let x = style.paddingX;
    const cy = cssHeight / 2;

    // Left dot + text
    ctx.fillStyle = style.loadDotColor;
    ctx.beginPath();
    ctx.arc(x + dot / 2, cy, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    x += dot + gap;

    ctx.font = `${style.fontPx}px ${style.fontFamily}`;
    ctx.fillStyle = style.textColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(textL, x, cy + 0.5);
    x += wL;

    // Separator
    x += gap / 2;
    ctx.strokeStyle = style.separatorColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, style.paddingY);
    ctx.lineTo(x + 0.5, cssHeight - style.paddingY);
    ctx.stroke();
    x += sep + gap / 2;

    // Right dot + text
    ctx.fillStyle = style.dumpDotColor;
    ctx.beginPath();
    ctx.arc(x + dot / 2, cy, dot / 2, 0, Math.PI * 2);
    ctx.fill();
    x += dot + gap;

    ctx.fillStyle = style.textColor;
    ctx.fillText(textD, x, cy + 0.5);

    return { canvas, cssWidth, cssHeight };
  }

  private roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    fillStyle: string
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fill();
  }
}
