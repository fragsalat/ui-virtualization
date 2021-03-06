import {inject} from 'aurelia-dependency-injection';
import {ObserverLocator} from 'aurelia-binding';
import {
  BoundViewFactory,
  ViewSlot,
  ViewResources,
  TargetInstruction,
  customAttribute,
  bindable,
  templateController,
  View
} from 'aurelia-templating';
import {
  AbstractRepeater,
  getItemsSourceExpression,
  isOneTime,
  unwrapExpression,
  updateOneTimeBinding,
  viewsRequireLifecycle
} from 'aurelia-templating-resources';
import {DOM} from 'aurelia-pal';
import {
  getStyleValue,
  calcOuterHeight,
  rebindAndMoveView
} from './utilities';
import {DomHelper} from './dom-helper';
import {VirtualRepeatStrategyLocator} from './virtual-repeat-strategy-locator';
import {TemplateStrategyLocator} from './template-strategy';

@customAttribute('virtual-repeat')
@templateController
@inject(DOM.Element, BoundViewFactory, TargetInstruction, ViewSlot, ViewResources, ObserverLocator, VirtualRepeatStrategyLocator, TemplateStrategyLocator, DomHelper)
export class VirtualRepeat extends AbstractRepeater {
  _first = 0;
  _previousFirst = 0;
  _viewsLength = 0;
  _lastRebind = 0;
  _topBufferHeight = 0;
  _bottomBufferHeight = 0;
  _bufferSize = 5;
  _scrollingDown = false;
  _scrollingUp = false;
  _switchedDirection = false;
  _isAttached = false;
  _ticking = false;
  _fixedHeightContainer = false;
  _hasCalculatedSizes = false;
  _isAtTop = true;
  _calledGetMore = false;

  @bindable items
  @bindable local
  constructor(
    element: Element,
    viewFactory: BoundViewFactory,
    instruction: TargetInstruction,
    viewSlot: ViewSlot,
    viewResources: ViewResources,
    observerLocator: ObserverLocator,
    strategyLocator: VirtualRepeatStrategyLocator,
    templateStrategyLocator: TemplateStrategyLocator,
    domHelper: DomHelper) {
    super({
      local: 'item',
      viewsRequireLifecycle: viewsRequireLifecycle(viewFactory)
    });

    this.element = element;
    this.viewFactory = viewFactory;
    this.instruction = instruction;
    this.viewSlot = viewSlot;
    this.lookupFunctions = viewResources.lookupFunctions;
    this.observerLocator = observerLocator;
    this.strategyLocator = strategyLocator;
    this.templateStrategyLocator = templateStrategyLocator;
    this.sourceExpression = getItemsSourceExpression(this.instruction, 'virtual-repeat.for');
    this.isOneTime = isOneTime(this.sourceExpression);
    this.domHelper = domHelper;
  }

  attached(): void {
    this._isAttached = true;
    let element = this.element;
    this._itemsLength = this.items.length;
    this.templateStrategy = this.templateStrategyLocator.getStrategy(element);
    this.scrollContainer = this.templateStrategy.getScrollContainer(element);
    this.topBuffer = this.templateStrategy.createTopBufferElement(element);
    this.bottomBuffer = this.templateStrategy.createBottomBufferElement(element);
    this.itemsChanged();
    this.scrollListener = () => this._onScroll();

    this.calcDistanceToTopInterval = setInterval(() => {
      let distanceToTop = this.distanceToTop;
      this.distanceToTop = this.domHelper.getElementDistanceToTopOfDocument(this.topBuffer);
      this.distanceToTop += this.topBufferDistance;
      if (distanceToTop !== this.distanceToTop) {
        this._handleScroll();
      }
    }, 500);

    this.distanceToTop = this.domHelper.getElementDistanceToTopOfDocument(this.templateStrategy.getFirstElement(this.topBuffer));
    // When dealing with tables, there can be gaps between elements, causing distances to be messed up. Might need to handle this case here.
    this.topBufferDistance = this.templateStrategy.getTopBufferDistance(this.topBuffer);

    if (this.domHelper.hasOverflowScroll(this.scrollContainer)) {
      this._fixedHeightContainer = true;
      this.scrollContainer.addEventListener('scroll', this.scrollListener);
    } else {
      document.addEventListener('scroll', this.scrollListener);
    }
  }

  bind(bindingContext, overrideContext): void {
    this.scope = { bindingContext, overrideContext };
    if (this._isAttached) {
      this.itemsChanged();
    }
  }

  call(context, changes): void {
    this[context](this.items, changes);
  }

  detached(): void {
    this.scrollContainer.removeEventListener('scroll', this.scrollListener);
    this._first = 0;
    this._previousFirst = 0;
    this._viewsLength = 0;
    this._lastRebind = 0;
    this._topBufferHeight = 0;
    this._bottomBufferHeight = 0;
    this._scrollingDown = false;
    this._scrollingUp = false;
    this._switchedDirection = false;
    this._isAttached = false;
    this._ticking = false;
    this._hasCalculatedSizes = false;
    this.templateStrategy.removeBufferElements(this.element, this.topBuffer, this.bottomBuffer);
    this.isLastIndex = false;
    this.scrollContainer = null;
    this.scrollContainerHeight = null;
    this.distanceToTop = null;
    this.removeAllViews(true);
    if (this.scrollHandler) {
      this.scrollHandler.dispose();
    }
    this._unsubscribeCollection();
    clearInterval(this.calcDistanceToTopInterval);
    if (this._sizeInterval) {
      clearInterval(this._sizeInterval);
    }
  }

  itemsChanged(): void {
    this._unsubscribeCollection();
    // still bound?
    if (!this.scope || !this._isAttached) {
      return;
    }
    let reducingItems = false;
    let previousLastViewIndex = this._getIndexOfLastView();

    let items = this.items;
    this.strategy = this.strategyLocator.getStrategy(items);
    if (items.length > 0 && this.viewCount() === 0) {
      this.strategy.createFirstItem(this);
    }
    // Skip scroll handling if we are decreasing item list
    // Otherwise if expanding list, call the handle scroll below
    if (this._itemsLength >= items.length) {
      //Scroll handle is redundant in this case since the instanceChanged will re-evaluate orderings
      //  Also, when items are reduced, we're not having to move any bindings, just a straight rebind of the items in the list
      this._skipNextScrollHandle = true;
      reducingItems = true;
    }
    this._checkFixedHeightContainer();
    this._calcInitialHeights(items.length);
    if (!this.isOneTime && !this._observeInnerCollection()) {
      this._observeCollection();
    }
    this.strategy.instanceChanged(this, items, this._first);
    this._lastRebind = this._first; //Reset rebinding

    if (reducingItems && previousLastViewIndex > this.items.length - 1) {
      //Do we need to set scrolltop so that we appear at the bottom of the list to match scrolling as far as we could?
      //We only want to execute this line if we're reducing such that it brings us to the bottom of the new list
      //Make sure we handle the special case of tables
      if (this.scrollContainer.tagName === 'TBODY') {
        let realScrollContainer = this.scrollContainer.parentNode.parentNode; //tbody > table > container
        realScrollContainer.scrollTop = realScrollContainer.scrollTop + (this.viewCount() * this.itemHeight);
      } else {
        this.scrollContainer.scrollTop = this.scrollContainer.scrollTop + (this.viewCount() * this.itemHeight);
      }
    }
    if (!reducingItems) {
      // If we're expanding our items, then we need to reset our previous first for the next go around of scroll handling
      this._previousFirst = this._first;
      this._scrollingDown = true; //Simulating the down scroll event to load up data appropriately
      this._scrollingUp = false;

      //Make sure we fix any state (we could have been at the last index before, but this doesn't get set until too late for scrolling)
      this.isLastIndex = this._getIndexOfLastView() >= this.items.length - 1;
    }

    //Need to readjust the scroll position to "move" us back to the appropriate position, since moving the views will shift our view port's percieved location
    this._handleScroll();
  }

  unbind(): void {
    this.scope = null;
    this.items = null;
    this._itemsLength = null;
  }

  handleCollectionMutated(collection, changes): void {
    this._handlingMutations = true;
    this._itemsLength = collection.length;
    this.strategy.instanceMutated(this, collection, changes);
  }

  handleInnerCollectionMutated(collection, changes): void {
    // guard against source expressions that have observable side-effects that could
    // cause an infinite loop- eg a value converter that mutates the source array.
    if (this.ignoreMutation) {
      return;
    }
    this.ignoreMutation = true;
    let newItems = this.sourceExpression.evaluate(this.scope, this.lookupFunctions);
    this.observerLocator.taskQueue.queueMicroTask(() => this.ignoreMutation = false);

    // call itemsChanged...
    if (newItems === this.items) {
      // call itemsChanged directly.
      this.itemsChanged();
    } else {
      // call itemsChanged indirectly by assigning the new collection value to
      // the items property, which will trigger the self-subscriber to call itemsChanged.
      this.items = newItems;
    }
  }

  _onScroll(): void {
    if (!this._ticking && !this._handlingMutations) {
      requestAnimationFrame(() => this._handleScroll());
      this._ticking = true;
    }

    if (this._handlingMutations) {
      this._handlingMutations = false;
    }
  }

  _handleScroll(): void {
    if (!this._isAttached) {
      return;
    }
    if (this._skipNextScrollHandle) {
      this._skipNextScrollHandle = false;
      return;
    }
    let itemHeight = this.itemHeight;
    let scrollTop = this._fixedHeightContainer ? this.scrollContainer.scrollTop : pageYOffset - this.distanceToTop;
    this._first = Math.floor(scrollTop / itemHeight);
    this._first = this._first < 0 ? 0 : this._first;
    if (this._first > this.items.length - this.elementsInView) {
      this._first = this.items.length - this.elementsInView;
      this._first = this._first < 0 ? 0 : this._first;
    }
    this._checkScrolling();
    // TODO if and else paths do almost same thing, refactor?
    if (this._scrollingDown) {
      let viewsToMove = this._first - this._lastRebind;
      if (this._switchedDirection) {
        viewsToMove = this._isAtTop ? this._first : this._bufferSize - (this._lastRebind - this._first);
      }
      this._isAtTop = false;
      this._lastRebind = this._first;
      let movedViewsCount = this._moveViews(viewsToMove);
      let adjustHeight = movedViewsCount < viewsToMove ? this._bottomBufferHeight : itemHeight * movedViewsCount;
      if (viewsToMove > 0) {
        this._getMore();
      }
      this._switchedDirection = false;
      this._topBufferHeight = this._topBufferHeight + adjustHeight;
      this._bottomBufferHeight = this._bottomBufferHeight - adjustHeight;
      if (this._bottomBufferHeight >= 0) {
        this._adjustBufferHeights();
      }
    } else if (this._scrollingUp) {
      let viewsToMove = this._lastRebind - this._first;
      let initialScrollState = this.isLastIndex === undefined; //Use for catching initial scroll state where a small page size might cause _getMore not to fire.
      if (this._switchedDirection) {
        if (this.isLastIndex) {
          viewsToMove = this.items.length - this._first - this.elementsInView;
        } else {
          viewsToMove = this._bufferSize - (this._first - this._lastRebind);
        }
      }
      this.isLastIndex = false;
      this._lastRebind = this._first;
      let movedViewsCount = this._moveViews(viewsToMove);
      this.movedViewsCount = movedViewsCount;
      let adjustHeight = movedViewsCount < viewsToMove ? this._topBufferHeight : itemHeight * movedViewsCount;
      if (viewsToMove > 0) {
        let force = this.movedViewsCount === 0 && initialScrollState && this._first <= 0 ? true : false;
        this._getMore(force);
      }
      this._switchedDirection = false;
      this._topBufferHeight = this._topBufferHeight - adjustHeight;
      this._bottomBufferHeight = this._bottomBufferHeight + adjustHeight;
      if (this._topBufferHeight >= 0) {
        this._adjustBufferHeights();
      }
    }
    this._previousFirst = this._first;

    this._ticking = false;
  }

  _getMore(force): void {
    if (this.isLastIndex || this._first === 0 || force) {
      if (!this._calledGetMore) {
        let executeGetMore = () => {
          this._calledGetMore = true;
          let func = (this.view(0) && this.view(0).firstChild && this.view(0).firstChild.au && this.view(0).firstChild.au['infinite-scroll-next']) ? this.view(0).firstChild.au['infinite-scroll-next'].instruction.attributes['infinite-scroll-next'] : undefined;
          let topIndex = this._first;
          let isAtBottom = this._bottomBufferHeight === 0;
          let isAtTop = this._isAtTop;
          let scrollContext = {
            topIndex: topIndex,
            isAtBottom: isAtBottom,
            isAtTop: isAtTop
          };

          this.scope.overrideContext.$scrollContext = scrollContext;

          if (func === undefined) {
            return null;
          } else if (typeof func === 'string') {
            let getMoreFuncName = this.view(0).firstChild.getAttribute('infinite-scroll-next');
            let funcCall = this.scope.overrideContext.bindingContext[getMoreFuncName];

            if (typeof funcCall === 'function') {
              let result = funcCall.call(this.scope.overrideContext.bindingContext, topIndex, isAtBottom, isAtTop);
              if (!(result instanceof Promise)) {
                this._calledGetMore = false; //Reset for the next time
              } else {
                return result.then(() => {
                  this._calledGetMore = false; //Reset for the next time
                });
              }
            } else {
              throw new Error("'infinite-scroll-next' must be a function or evaluate to one");
            }
          } else if (func.sourceExpression) {
            this._calledGetMore = false; //Reset for the next time
            return func.sourceExpression.evaluate(this.scope);
          } else {
            throw new Error("'infinite-scroll-next' must be a function or evaluate to one");
          }
          return null;
        };

        this.observerLocator.taskQueue.queueMicroTask(executeGetMore);
      }
    }
  }

  _checkScrolling(): void {
    if (this._first > this._previousFirst && (this._bottomBufferHeight > 0 || !this.isLastIndex)) {
      if (!this._scrollingDown) {
        this._scrollingDown = true;
        this._scrollingUp = false;
        this._switchedDirection = true;
      } else {
        this._switchedDirection = false;
      }
      this._isScrolling = true;
    } else if (this._first < this._previousFirst && (this._topBufferHeight >= 0 || !this._isAtTop)) {
      if (!this._scrollingUp) {
        this._scrollingDown = false;
        this._scrollingUp = true;
        this._switchedDirection = true;
      } else {
        this._switchedDirection = false;
      }
      this._isScrolling = true;
    } else {
      this._isScrolling = false;
    }
  }

  _checkFixedHeightContainer(): void {
    if (this.domHelper.hasOverflowScroll(this.scrollContainer)) {
      this._fixedHeightContainer = true;
    }
  }

  _adjustBufferHeights(): void {
    this.topBuffer.style.height = `${this._topBufferHeight}px`;
    this.bottomBuffer.style.height = `${this._bottomBufferHeight}px`;
  }

  _unsubscribeCollection(): void {
    if (this.collectionObserver) {
      this.collectionObserver.unsubscribe(this.callContext, this);
      this.collectionObserver = null;
      this.callContext = null;
    }
  }

  _moveViews(length: number): number {
    let getNextIndex = this._scrollingDown ? (index, i) =>  index + i : (index, i) =>  index - i;
    let isAtFirstOrLastIndex = () => this._scrollingDown ? this.isLastIndex : this._isAtTop;
    let childrenLength = this.viewCount();
    let viewIndex = this._scrollingDown ? 0 : childrenLength - 1;
    let items = this.items;
    let index = this._scrollingDown ? this._getIndexOfLastView() + 1 : this._getIndexOfFirstView() - 1;
    let i = 0;
    let viewToMoveLimit = length - (childrenLength * 2);
    while (i < length && !isAtFirstOrLastIndex()) {
      let view = this.view(viewIndex);
      let nextIndex = getNextIndex(index, i);
      this.isLastIndex = nextIndex >= items.length - 1;
      this._isAtTop = nextIndex <= 0;
      if (!(isAtFirstOrLastIndex() && childrenLength >= items.length)) {
        if (i > viewToMoveLimit) {
          rebindAndMoveView(this, view, nextIndex, this._scrollingDown);
        }
        i++;
      }
    }
    return length - (length - i);
  }

  _getIndexOfLastView(): number {
    const view = this.view(this.viewCount() - 1);
    if (view) {
      return view.overrideContext.$index;
    }

    return -1;
  }

  _getLastViewItem() {
    let children = this.viewSlot.children;
    if (!children.length) {
      return undefined;
    }
    let lastViewItem = children[children.length - 1].bindingContext[this.local];
    return lastViewItem;
  }

  _getIndexOfFirstView(): number {
    return this.view(0) ? this.view(0).overrideContext.$index : -1;
  }

  _calcInitialHeights(itemsLength: number): void {
    if (this._viewsLength > 0 && this._itemsLength === itemsLength || !this.viewCount()) {
      return;
    }
    this._hasCalculatedSizes = true;
    let firstViewElement = this.view(0).lastChild;
    this.itemHeight = calcOuterHeight(firstViewElement);
    if (this.itemHeight <= 0) {
      this._sizeInterval = setInterval(()=>{
        let newCalcSize = calcOuterHeight(firstViewElement);
        if (newCalcSize > 0) {
          clearInterval(this._sizeInterval);
          this.itemsChanged();
        }
      }, 500);
      return;
    }

    this._itemsLength = itemsLength;
    this.scrollContainerHeight = this._fixedHeightContainer ? this._calcScrollHeight(this.scrollContainer) : document.documentElement.clientHeight;
    this.elementsInView = Math.ceil(this.scrollContainerHeight / this.itemHeight) + 1;
    this._viewsLength = (this.elementsInView * 2) + this._bufferSize;

    //Look at top buffer height (how far we've scrolled down)
    //If top buffer height is greater than the new bottom buffer height (how far we *can* scroll down)
    //    Then set top buffer height to max it can be (bottom buffer height - views in length?) and bottom buffer height to 0
    let newBottomBufferHeight = this.itemHeight * itemsLength - this.itemHeight * this._viewsLength; //How much buffer room to the bottom if you were at the top
    if (newBottomBufferHeight < 0) { // In case of small lists, ensure that we never set the buffer heights to impossible values
      newBottomBufferHeight = 0;
    }
    if (this._topBufferHeight >= newBottomBufferHeight) { //Use case when items are removed (we've scrolled past where we can)
      this._topBufferHeight = newBottomBufferHeight;
      this._bottomBufferHeight = 0;
      this._first = this._itemsLength - this._viewsLength;
      if (this._first < 0) { // In case of small lists, ensure that we never set first to less than possible
        this._first = 0;
      }
    } else { //Use case when items are added (we are adding scrollable space to the bottom)
      // We need to re-evaluate which is the true "first". If we've added items, then the previous "first" is actually too far down the list
      this._first = this._getIndexOfFirstView();
      let adjustedTopBufferHeight = this._first * this.itemHeight; //appropriate buffer height for top, might be 1 too long...
      this._topBufferHeight = adjustedTopBufferHeight;
      //But what about when we've only scrolled slightly down the list? We need to readjust the top buffer height then
      this._bottomBufferHeight = newBottomBufferHeight - adjustedTopBufferHeight;
      if (this._bottomBufferHeight < 0) {
        this._bottomBufferHeight = 0;
      }
    }
    this._adjustBufferHeights();
    return;
  }

  _calcScrollHeight(element: Element): number {
    let height;
    height = element.getBoundingClientRect().height;
    height -= getStyleValue(element, 'borderTopWidth');
    height -= getStyleValue(element, 'borderBottomWidth');
    return height;
  }

  _observeInnerCollection(): boolean {
    let items = this._getInnerCollection();
    let strategy = this.strategyLocator.getStrategy(items);
    if (!strategy) {
      return false;
    }
    this.collectionObserver = strategy.getCollectionObserver(this.observerLocator, items);
    if (!this.collectionObserver) {
      return false;
    }
    this.callContext = 'handleInnerCollectionMutated';
    this.collectionObserver.subscribe(this.callContext, this);
    return true;
  }

  _getInnerCollection(): any {
    let expression = unwrapExpression(this.sourceExpression);
    if (!expression) {
      return null;
    }
    return expression.evaluate(this.scope, null);
  }

  _observeCollection(): void {
    let items = this.items;
    this.collectionObserver = this.strategy.getCollectionObserver(this.observerLocator, items);
    if (this.collectionObserver) {
      this.callContext = 'handleCollectionMutated';
      this.collectionObserver.subscribe(this.callContext, this);
    }
  }

  // @override AbstractRepeater
  // How will these behaviors need to change since we are in a virtual list instead?
  viewCount() { return this.viewSlot.children.length; }
  views() { return this.viewSlot.children; }
  view(index) { return this.viewSlot.children[index]; }

  addView(bindingContext, overrideContext) {
    let view = this.viewFactory.create();
    view.bind(bindingContext, overrideContext);
    this.viewSlot.add(view);
  }

  insertView(index, bindingContext, overrideContext) {
    let view = this.viewFactory.create();
    view.bind(bindingContext, overrideContext);
    this.viewSlot.insert(index, view);
  }

  removeAllViews(returnToCache, skipAnimation) {
    return this.viewSlot.removeAll(returnToCache, skipAnimation);
  }

  removeView(index, returnToCache, skipAnimation) {
    return this.viewSlot.removeAt(index, returnToCache, skipAnimation);
  }

  updateBindings(view: View) {
    let j = view.bindings.length;
    while (j--) {
      updateOneTimeBinding(view.bindings[j]);
    }
    j = view.controllers.length;
    while (j--) {
      let k = view.controllers[j].boundProperties.length;
      while (k--) {
        let binding = view.controllers[j].boundProperties[k].binding;
        updateOneTimeBinding(binding);
      }
    }
  }
}
