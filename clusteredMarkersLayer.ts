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
import { ClusterBadgeStyle, ClusterCat, ClusteredMarkersOptions, ClusterKey, MarkerData } from './marker.model';
import { formatDateToIST, formatSecondsToMinSec } from './markerUtils';

export class ClusteredMarkersLayer {
  public readonly viewer: Viewer;
  public readonly dataSource: CustomDataSource;
  public options: Required<ClusteredMarkersOptions>;

  private clickHandler?: ScreenSpaceEventHandler;
  private markerIds = new Set<string>();
  private clusterMembers = new Map<ClusterKey, Entity[]>();

  private clusterStyler: (clusteredEntities: Entity[], cluster: any) => void;

  private popupEl?: HTMLDivElement;
  private popupAnchor?: Entity;
  private popupTrackUnsub?: () => void;
  private carousel?: { entities: Entity[]; index: number; anchor: Entity };

  private dpi = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  private trackingAttached = false;

  // camera-height-based clustering toggle
  private postRenderUnsub?: () => void;
  private clusteringRuntimeEnabled = true;

  constructor(viewer: Viewer, data: MarkerData[], options?: ClusteredMarkersOptions) {
    this.viewer = viewer;

    // Render at device pixel ratio (capped) to keep canvases & billboards crisp
    try {
      (this.viewer as any).resolutionScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    } catch {}

    const defaults: Required<ClusteredMarkersOptions> = {
      enabled: true,
      pixelRange: 200,
      minimumClusterSize: 2,
      pointPixelSize: 12.5,
      getPointColor: (popup) => Color.fromCssColorString((popup?.['color'] as string) || '#1976d2'),
      badgeStyle: {
        fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        fontPx: 12,
        paddingX: 8,
        paddingY: 8,
        rowGapPx: 4,
        backgroundColor: 'whitesmoke',
        textColor: '#000000',
        separatorColor: '#000000',
        borderColor: '#000000',
        borderWidth: 1,
        dotDiameterPx: 6,
        dotGapPx: 6,
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
      minCameraHeightForClustering: 15,
    };

    this.options = { ...defaults, ...(options || {}) };
    if (!options?.minSeparationPx) {
      this.options.minSeparationPx = (options?.pixelRange ?? this.options.pixelRange) + 4;
    }

    this.dataSource = new CustomDataSource(this.options.dataSourceName);
    void this.viewer.dataSources.add(this.dataSource);

    // Cluster styler → dynamically handle categories and per-bucket dot colors (mode of member colors)
    this.clusterStyler = (clusteredEntities, cluster) => {
      const buckets = this.buildBuckets(clusteredEntities);
      const rows = this.buildRowsForBuckets(buckets); // {label, count, dotCss}

      cluster.label.show = false;

      const out = this.drawClusterVerticalBadge(rows, this.options.badgeStyle);

      cluster.billboard.show = true;
      cluster.billboard.image = out.canvas.toDataURL('image/png');
      cluster.billboard.verticalOrigin = VerticalOrigin.CENTER;
      cluster.billboard.width = out.cssWidth | 0;   // ensure integers (crisp)
      cluster.billboard.height = out.cssHeight | 0; // ensure integers (crisp)
      cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;

      // unify picking & store members with a stable key
      const sharedId = cluster.label.id;
      const key = this.clusterKeyFrom(sharedId);
      cluster.billboard.id = sharedId;
      if (cluster.point) cluster.point.id = sharedId;
      this.clusterMembers.set(key, clusteredEntities);
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

    // crisp badges on DPR changes
    window.addEventListener('resize', this.onDpiChange);
    try {
      window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)?.addEventListener?.('change', this.onDpiChange);
    } catch { }

    // camera-height based clustering toggle
    const remove = this.viewer.scene.postRender.addEventListener(() => this.updateClusteringByCameraHeight());
    this.postRenderUnsub = () => remove();
  }

  // ---------- Public API ----------

  public setData(markers: MarkerData[]): void {
    this.clusterMembers.clear();
    this.markerIds.clear();
    this.dataSource.entities.removeAll();

    for (const marker of markers) {
      const { lat, lng } = marker.point;
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const position = Cartesian3.fromDegrees(lng, lat, 0);

      const px = Math.max(1, Math.round(this.options.pointPixelSize));
      const outlineW = Math.max(0, Math.round(2));

      const entity = this.dataSource.entities.add({
        position,
        point: {
          pixelSize: px,
          color: Color.fromCssColorString(marker.options.color),
          outlineColor: Color.WHITESMOKE,
          outlineWidth: outlineW,
        },
      });

      // store JSON for popup & classification & dynamic dot color
      const pd: Record<string, any> = {
        ...marker.popupData,
        color: marker.options.color,          // used as the per-marker dot color
        segmentDesc: marker.popupData?.['segmentDesc'] ?? null,
        subState: marker.popupData?.['subState'] ?? null,
      };

      entity.properties = new PropertyBag(pd as any);
      (entity as any).__popup = pd;
      (entity as any).__cat = this.classify(pd);
      (entity as any).__dotColor = String(marker.options.color || '#000000');
      (entity as any).__icon = marker.options.icon;

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

    window.removeEventListener('resize', this.onDpiChange);
    try {
      window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)?.removeEventListener?.('change', this.onDpiChange);
    } catch { }

    if (this.postRenderUnsub) this.postRenderUnsub();
  }

  public refreshClusterBadges(): void {
    this.forceClusterRefresh();
  }

  // ---------- Classification ----------

  private classify(popup: Record<string, any>): ClusterCat {
    const seg = String(popup?.['segmentDesc'] ?? '').trim().toLowerCase();
    if (seg === 'load') return 'L';
    if (seg === 'dump') return 'D';

    const sub = String(popup?.['subState'] ?? '').trim().toLowerCase();
    switch (sub) {
      case 'working': return 'W';
      case 'productive idling': return 'PL';
      case 'short idling': return 'SI';
      case 'medium idling': return 'MI';
      case 'long idling': return 'LI';
      case 'engine stop': return 'ES';
      default: return 'SI'; // safe fallback
    }
  }

  // ---------- Bucketing with dynamic dot colors ----------

  private buildBuckets(entities: Entity[]): {
    counts: Record<ClusterCat, number>;
    // representative color per bucket (mode of marker colors)
    dotCss: Partial<Record<ClusterCat, string>>;
  } {
    const counts: Record<ClusterCat, number> = { L: 0, D: 0, PL: 0, SI: 0, LI: 0, MI: 0, W: 0, ES: 0 };
    const colorCounts: Partial<Record<ClusterCat, Map<string, number>>> = {};
    const now = JulianDate.now();

    for (const e of entities) {
      const pd: Record<string, any> | undefined = (e as any).__popup ?? (e.properties as any)?.getValue?.(now);
      const cat: ClusterCat = (e as any).__cat ?? this.classify(pd || {});
      counts[cat] = (counts[cat] || 0) + 1;

      const cssCol = String((e as any).__dotColor || pd?.['color'] || '#000000');
      const map = (colorCounts[cat] ??= new Map<string, number>());
      map.set(cssCol, (map.get(cssCol) || 0) + 1);
    }

    const dotCss: Partial<Record<ClusterCat, string>> = {};
    (Object.keys(counts) as ClusterCat[]).forEach((cat) => {
      const map = colorCounts[cat];
      if (!map || map.size === 0) return;
      let best = '#000000';
      let bestN = -1;
      for (const [col, n] of map) {
        if (n > bestN) { bestN = n; best = col; }
      }
      dotCss[cat] = best;
    });

    return { counts, dotCss };
  }

  private buildRowsForBuckets(b: {
    counts: Record<ClusterCat, number>;
    dotCss: Partial<Record<ClusterCat, string>>;
  }): Array<{ label: string; count: number; dotCss: string }> {
    // deterministic vertical order
    const order: ClusterCat[] = ['L', 'D', 'W', 'PL', 'SI', 'MI', 'LI', 'ES'];

    const rows: Array<{ label: string; count: number; dotCss: string }> = [];
    for (const cat of order) {
      const count = b.counts[cat] || 0;
      if (count <= 0) continue;
      rows.push({
        label: cat,
        count,
        dotCss: b.dotCss[cat] ?? '#000000',
      });
    }
    return rows;
  }

  // ---------- Cluster badge drawing (VERTICAL RECTANGLE) ----------

  private drawClusterVerticalBadge(
    rows: Array<{ label: string; count: number; dotCss: string }>,
    style: ClusterBadgeStyle
  ): { canvas: HTMLCanvasElement; cssWidth: number; cssHeight: number } {
    // Include font family in measurement for consistent metrics
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = `${style.fontPx}px ${style.fontFamily}`;

    const dot = Math.max(1, Math.round(style.dotDiameterPx));
    const gap = Math.max(0, Math.round(style.dotGapPx));
    const rowGap = Math.max(0, Math.round(style.rowGapPx));
    const rowH = Math.max(1, Math.round(style.fontPx));

    const texts = rows.map(r => `${r.label} ${r.count}`);
    const textWidths = texts.map(t => measure.measureText(t).width);

    const contentW = texts.length ? Math.max(...textWidths.map(w => Math.ceil(w)), 0) : 0;
    const contentWidth = (dot + gap) + contentW;

    const contentHeight = rows.length > 0
      ? rows.length * rowH + (rows.length - 1) * rowGap
      : rowH;

    // CSS pixel size should be integer to avoid resampling
    const cssWidth = Math.ceil(contentWidth + style.paddingX * 2);
    const cssHeight = Math.ceil(contentHeight + style.paddingY * 2);

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    const canvas = document.createElement('canvas');
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;

    const ctx = canvas.getContext('2d', { alpha: true })!;
    // Draw in device pixels; no fractional transforms
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Avoid image resampling artifacts
    (ctx as any).imageSmoothingEnabled = false;

    // Background (align to integer px in CSS space)
    ctx.fillStyle = style.backgroundColor;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    // Border at exact 1 CSS px
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = Math.max(1, Math.round(style.borderWidth));
    ctx.strokeRect(0.5, 0.5, cssWidth - 1, cssHeight - 1);

    ctx.font = `${rowH}px ${style.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.textColor;

    let y = style.paddingY + Math.floor(rowH / 2);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cx = style.paddingX + Math.floor(dot / 2);

      // Dot
      ctx.fillStyle = r.dotCss;
      ctx.beginPath();
      ctx.arc(cx, y, dot / 2, 0, Math.PI * 2);
      ctx.fill();

      // Text (integer x)
      ctx.fillStyle = style.textColor;
      const tx = style.paddingX + dot + gap;
      ctx.fillText(texts[i], tx, y);

      y += rowH;
      if (i < rows.length - 1) y += rowGap;
    }

    return { canvas, cssWidth, cssHeight };
  }

  // ---------- Click handling / popups ----------

  private installClickHandler(): void {
    this.clickHandler?.destroy();
    this.clickHandler = new ScreenSpaceEventHandler(this.viewer.scene.canvas);

    // LEFT CLICK
    this.clickHandler.setInputAction(async (movement: { position: Cartesian2; }) => {
      const picked = this.viewer.scene.pick(movement.position);

      if (!picked || !picked.id) {
        this.hidePopup();
        return;
      }

      const entity = picked.id as Entity;
      const pos = picked.primitive?.position;
      if (!pos) {
        this.hidePopup();
        return;
      }

      const carto = Cartographic.fromCartesian(pos);
      const lat = CesiumMath.toDegrees(carto.latitude);
      const lon = CesiumMath.toDegrees(carto.longitude);
      const key = this.clusterKeyFrom(picked.id);

      // Cluster clicked
      if (this.clusterMembers.has(key)) {
        const members = this.clusterMembers.get(key)!;

        if (this.options.onClusterClick) {
          this.options.onClusterClick({ clusterEntity: entity, members, lat, lon });
        }

        if (this.options.ensureDeclusterOnClick) {
          const buckets = this.buildBuckets(members).counts;
          const nonZero = Object.values(buckets).filter((n) => n > 0).length;
          const perStep = nonZero > 1 ? this.options.mixedExtraZoomFactor : this.options.singleExtraZoomFactor;

          await this.zoomToSeparate(members, {
            targetMinPx: this.options.minSeparationPx,
            maxSteps: this.options.maxZoomIters,
            perStepFactor: perStep,
          });
        } else {
          await this.zoomToEntitiesOnce(members);
        }

        this.hidePopup();
        return;
      }

      // Single marker clicked
      if (entity.id && this.markerIds.has(entity.id)) {
        const evt: Record<string, any> | undefined = (entity as any).__popup;

        if (this.options.onMarkerClick) {
          this.options.onMarkerClick({ entity, event: evt, lat, lon });
        }

        const picks = this.viewer.scene.drillPick(movement.position) as any[];
        const now2 = JulianDate.now();
        const refPos = (entity as any).position?.getValue?.(now2);

        const allMarkerEntities = picks
          .map((p) => p?.id as Entity)
          .filter((e): e is Entity => !!e && !!(e as any).__popup && this.markerIds.has(e.id));

        const samePlace: Entity[] = [];
        for (const e of allMarkerEntities) {
          const p = (e as any).position?.getValue?.(now2);
          if (!p) continue;
          if (Cartesian3.distance(refPos, p) <= 1.0) samePlace.push(e);
        }

        if (samePlace.length > 1) {
          this.showCarouselPopup(samePlace, entity);
        } else if (this.options.popupEnabled) {
          const html = this.options.buildPopupHtml
            ? this.options.buildPopupHtml(evt!, entity)
            : this.buildDefaultPopupHtml(evt!, lat, lon);
          this.showPopupAt(entity, html);
        }
        return;
      }

      this.hidePopup();
    }, ScreenSpaceEventType.LEFT_CLICK);

    // RIGHT CLICK → close popup
    this.clickHandler.setInputAction(() => this.hidePopup(), ScreenSpaceEventType.RIGHT_CLICK);
  }

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
      transform: 'translate(-50%, -100%)', // anchor above tip
      borderRadius: '6px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      pointerEvents: 'auto',
      maxWidth: '320px',
      fontSize: '12px',
      lineHeight: '1.4',
      border: '1px solid #e8e8e8',
      willChange: 'left, top',
    } as CSSStyleDeclaration);

    // arrow element (always present)
    const arrow = document.createElement('div');
    arrow.className = 'cm-arrow';
    Object.assign(arrow.style, {
      position: 'absolute',
      left: '50%',
      bottom: '-10px',
      transform: 'translateX(-50%)',
      width: '0',
      height: '0',
      borderLeft: '10px solid transparent',
      borderRight: '10px solid transparent',
      borderTop: '10px solid white',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    el.appendChild(arrow);
    this.viewer.container.appendChild(el);
    this.popupEl = el;
  }

  private setPopupContent(html: string): void {
    if (!this.popupEl) return;
    // keep the arrow as the last child intact
    const arrow = this.popupEl.querySelector('.cm-arrow');
    this.popupEl.innerHTML = `<div class="cm-body">${html}</div>`;
    if (arrow) this.popupEl.appendChild(arrow);
  }

  private enablePopupTracking(): void {
    if (this.trackingAttached) return;
    this.disablePopupTracking();
    const anchor = this.carousel?.anchor ?? this.popupAnchor;
    if (!anchor) return;
    const scene = this.viewer.scene;
    const tick = () => this.positionPopupAt(anchor);
    const remove = scene.postRender.addEventListener(tick);
    this.popupTrackUnsub = () => { remove(); this.trackingAttached = false; };
    this.trackingAttached = true;
  }

  private disablePopupTracking(): void {
    if (this.popupTrackUnsub) this.popupTrackUnsub();
    this.popupTrackUnsub = undefined;
    this.trackingAttached = false;
  }

  private positionPopupAt(entity: Entity): void {
    if (!this.popupEl) return;
    const now = JulianDate.now();
    const pos = (entity as any).position?.getValue?.(now);
    if (!pos) return;

    const scene = this.viewer.scene;
    const container = this.viewer.container;
    const win = SceneTransforms.worldToWindowCoordinates(scene, pos);
    if (!win) return;

    const arrowH = 10; // must match CSS (border-top)
    const pad = 8;

    const el = this.popupEl;

    // Ideal tip anchor (win.x, win.y)
    let left = Math.round(win.x);
    let top = Math.round(win.y - arrowH);

    // With translate(-50%, -100%), (left, top) is the tip location.
    // Clamp the box within container.
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    let elLeft = left - Math.round(width / 2);
    let elTop = top - height;

    const minLeft = pad;
    const maxLeft = container.clientWidth - width - pad;
    const minTop = pad;
    const maxTop = container.clientHeight - height - pad;

    elLeft = Math.max(minLeft, Math.min(elLeft, maxLeft));
    elTop = Math.max(minTop, Math.min(elTop, maxTop));

    el.style.left = `${elLeft + Math.round(width / 2)}px`;
    el.style.top = `${elTop + height}px`;

    // Slide the arrow horizontally so its tip remains at the screen x
    const arrow = el.querySelector<HTMLDivElement>('.cm-arrow');
    if (arrow) {
      let arrowCenter = win.x - elLeft; // px within popup
      arrowCenter = Math.max(12, Math.min(arrowCenter, width - 12));
      arrow.style.left = `${Math.round(arrowCenter)}px`;
    }
  }

  private showPopupAt(entity: Entity, html: string): void {
    this.ensurePopupEl();
    if (!this.popupEl) return;
    this.carousel = undefined;
    this.popupAnchor = entity;
    this.setPopupContent(html);
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

  private showCarouselPopup(entities: Entity[], anchor: any): void {
    this.ensurePopupEl();
    if (!this.popupEl) return;

    this.carousel = { entities, index: 0, anchor };
    this.popupAnchor = undefined;

    const html = `
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="cm-prev" title="Previous" style="
          display:flex;align-items:center;justify-content:center;
          width:36px;height:36px;border:1px solid #ddd;background:#f9f9f9;
          border-radius:50%; cursor:pointer; flex:0 0 36px;">
          <span style="font-size:22px;line-height:1;">&#8249;</span>
        </button>
        <div class="cm-content" style="flex:1; min-width:220px;"></div>
        <button class="cm-next" title="Next" style="
          display:flex;align-items:center;justify-content:center;
          width:36px;height:36px;border:1px solid #ddd;background:#f9f9f9;
          border-radius:50%; cursor:pointer; flex:0 0 36px;">
          <span style="font-size:22px;line-height:1;">&#8250;</span>
        </button>
      </div>
      <div class="cm-indicator" style="margin-top:6px; text-align:center; color:#666; font-weight:600;"></div>
    `;

    this.setPopupContent(html);
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

    const evt: Record<string, any> | undefined = (e as any).__popup;
    const html = this.options.buildPopupHtml
      ? this.options.buildPopupHtml(evt!, e)
      : this.buildDefaultPopupHtml(evt!, lat, lon);

    const content = this.popupEl.querySelector<HTMLDivElement>('.cm-content')!;
    const indicator = this.popupEl.querySelector<HTMLDivElement>('.cm-indicator')!;
    if (content) content.innerHTML = html;
    if (indicator) indicator.textContent = `${index + 1} / ${entities.length}`;

    this.positionPopupAt(anchor);
  }

  private buildDefaultPopupHtml(evt: Record<string, any> | undefined, lat: number, lon: number): string {
    if (!evt) {
      return `<div><strong>Marker</strong><br/>Lat: ${lat.toFixed(6)}, Lon: ${lon.toFixed(6)}</div>`;
    }

    const rows = evt['subState'] ?
      `
          <div style="display:flex;gap:8px;margin:5px 0;">
            <div style="min-width:120px;color:#666;">Fuel Burn</div>
            <div style="flex:1;font-weight:600;">${evt['fuelConsumption']} gal</div>
          </div>
          <div style="display:flex;gap:8px;margin:5px 0;">
            <div style="min-width:120px;color:#666;">${evt['subState'].replace(/Idling$/, 'Idle Events')}</div>
            <div style="flex:1;font-weight:600;">${formatSecondsToMinSec(+evt['duration'])}</div>
          </div>
        `: `
          <div style="display:flex;gap:8px;margin:5px 0;">
            <div style="min-width:120px;">Payload</div>
            <div style="flex:1;font-weight:600;">${evt['payload']} ton</div>
          </div>
          <div style="display:flex;gap:8px;margin:5px 0;">
            <div style="min-width:120px;">Hauler ${evt['segmentDesc']} Time</div>
            <div style="flex:1;font-weight:600;">${formatSecondsToMinSec(+evt['cycleDuration'])}</div>
          </div>
        `;

    return `
    <div>
      <div style="margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <img style="width:60px" src="/assets/images/asset-default.svg"/>
          <div>
          <p style="margin:0;font-weight: 500;">${evt['equipmentId']}</p>
          <p style="margin:0;">${evt['serialNumber']} - ${evt['make']}</p>
          </div>
        </div>
        <div style="position:relative;text-align:center;margin:8px 0;">
          <hr style="border:none;border-top:1px solid #eee;" />
          <p style="position:absolute;top:-5px;left:50%;transform:translateX(-50%);background:#fff;font-size:10px;">
            ${formatDateToIST(evt['endTime'] || evt['machineEndTime'])}
          </p>
        </div>
      </div>
      ${rows}
    </div>
  `;
  }

  // ---------- Zoom helpers ----------

  private rectangleFromEntities(entities: Entity | Entity[]): Rectangle | undefined {
    const arr = Array.isArray(entities) ? entities : [entities];
    const now = JulianDate.now();
    const cartos: Cartographic[] = [];
    for (const e of arr) {
      const p = (e as any).position?.getValue?.(now);
      if (!p) continue;
      cartos.push(Cartographic.fromCartesian(p));
    }
    if (cartos.length === 0) return undefined;

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

    await this.flyToRectangle(rect, 0.2);
    await this.waitOnePostRender();

    let prevMinPx = this.minPixelSeparation(entities);
    for (let step = 0; step < maxSteps; step++) {
      const minPx = this.minPixelSeparation(entities);
      if (minPx === Infinity || minPx >= targetMinPx) break;

      rect = this.shrinkRectangle(rect, perStepFactor);
      await this.flyToRectangle(rect, 0.5);
      await this.waitOnePostRender();

      this.forceClusterRefresh();
      await this.waitOnePostRender();

      if (minPx - prevMinPx < 1) break;
      prevMinPx = minPx;
    }
  }

  private shrinkRectangle(rect: Rectangle, factor: number): Rectangle {
    const cx = (rect.west + rect.east) / 2;
    const cy = (rect.south + rect.north) / 2;
    const hw = (rect.east - rect.west) * 0.5 * factor;
    const hh = (rect.north - rect.south) * 0.5 * factor;
    return new Rectangle(cx - hw, cy - hh, cx + hw, cy + hh);
  }

  private flyToRectangle(rect: Rectangle, duration = 0.2): Promise<void> {
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

  // ---------- Camera-height based clustering toggle ----------

  private updateClusteringByCameraHeight(): void {
    const cameraCarto = Cartographic.fromCartesian(this.viewer.camera.position);
    const height = cameraCarto?.height ?? Number.POSITIVE_INFINITY;

    const shouldCluster = height >= this.options.minCameraHeightForClustering;
    if (shouldCluster !== this.clusteringRuntimeEnabled) {
      this.clusteringRuntimeEnabled = shouldCluster;

      const clustering = this.dataSource.clustering;
      clustering.enabled = shouldCluster && this.options.enabled;

      // force recluster/revert immediately
      this.forceClusterRefresh();
    }
  }

  // ---------- Utilities ----------

  private clusterKeyFrom(anyId: unknown): ClusterKey {
    if (!anyId) return '';
    if ((anyId as Entity)?.id) return String((anyId as Entity).id);
    return String(anyId as any);
  }

  private forceClusterRefresh(): void {
    const c = this.dataSource.clustering;
    const prev = c.pixelRange;
    c.pixelRange = prev === 0 ? 1 : 0;
    c.pixelRange = prev;
    this.viewer.scene.requestRender();
  }

  private onDpiChange = () => {
    const now = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    if (now !== this.dpi) {
      this.dpi = now;
      this.forceClusterRefresh();
    }
  };
}
